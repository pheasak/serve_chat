const WebSocket = require('ws');
const http = require('http');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const { MongoClient } = require('mongodb');
dotenv.config();

// Configuration
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'websocket_chat';

// Create HTTP server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Database connection
let db;
let client;

// Collections
const collections = {
  MESSAGES: 'messages',
  USERS: 'users',
  QUEUED_MESSAGES: 'queued_messages'
};

// Store active connections
const activeConnections = new Map();
const pendingAcknowledgments = new Map();

async function connectToMongo() {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('Connected to MongoDB');

    // Create indexes
    await db.collection(collections.MESSAGES).createIndex({ id: 1 }, { unique: true });
    await db.collection(collections.MESSAGES).createIndex({ from: 1 });
    await db.collection(collections.MESSAGES).createIndex({ to: 1 });
    await db.collection(collections.USERS).createIndex({ username: 1 }, { unique: true });
    console.log('Database indexes created');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Handle HTTP requests
server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    connectedUsers: activeConnections.size,
    uptime: process.uptime()
  }));
});

wss.on('connection', (ws, req) => {
  // Handle CORS if needed
  const origin = req.headers.origin;
  if (origin) {
    ws.upgradeReq.headers['Access-Control-Allow-Origin'] = origin;
  }

  let username = '';
  let userData = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // Handle typing indicator
      if (data.type === 'typing') {
        const recipient = activeConnections.get(data.to);
        if (recipient && recipient.readyState === WebSocket.OPEN) {
          recipient.send(JSON.stringify({
            type: 'typing',
            from: username,
            isTyping: data.isTyping
          }));
        }
        return;
      }

      // User registration
      if (data.type === 'register') {
        username = data.username;
        activeConnections.set(username, ws);

        // Check if user exists in DB or create new
        userData = await db.collection(collections.USERS).findOne({ username });
        if (!userData) {
          userData = {
            username,
            ipAddress: req.socket.remoteAddress,
            firstSeen: new Date(),
            lastSeen: new Date(),
            online: true
          };
          await db.collection(collections.USERS).insertOne(userData);
        } else {
          await db.collection(collections.USERS).updateOne(
            { username },
            { $set: { lastSeen: new Date(), online: true } }
          );
        }

        console.log(`${username} connected from ${req.socket.remoteAddress}`);

        // Deliver queued messages from database
        const queuedMessages = await db.collection(collections.QUEUED_MESSAGES)
          .find({ to: username })
          .sort({ timestamp: 1 })
          .toArray();

        if (queuedMessages.length > 0) {
          queuedMessages.forEach(async msg => {
            ws.send(JSON.stringify({
              type: 'message',
              id: msg.id,
              from: msg.from,
              text: msg.text,
              timestamp: msg.timestamp,
              status: 'delivered'
            }));

            // Update message status in DB
            await db.collection(collections.MESSAGES).updateOne(
              { id: msg.id },
              { $set: { status: 'delivered', deliveredAt: new Date() } }
            );

            // Remove from queued messages
            await db.collection(collections.QUEUED_MESSAGES).deleteOne({ id: msg.id });
          });
        }

        // Send message history (last 50 messages)
        const messageHistory = await db.collection(collections.MESSAGES)
          .find({
            $or: [
              { from: username },
              { to: username }
            ]
          })
          .sort({ timestamp: -1 })
          .limit(50)
          .toArray();

        ws.send(JSON.stringify({
          type: 'message_history',
          messages: messageHistory.reverse()
        }));

        broadcastUserList();
        return;
      }

      // Handle messages
      if (data.type === 'message') {
        const messageId = data.id || uuidv4();
        const recipient = activeConnections.get(data.to);
        const timestamp = new Date().toISOString();

        // Create message document
        const messageDoc = {
          id: messageId,
          from: username,
          to: data.to,
          text: data.text,
          timestamp,
          status: recipient ? 'delivering' : 'queued',
          createdAt: new Date()
        };

        // Save to database
        await db.collection(collections.MESSAGES).insertOne(messageDoc);

        // Track for acknowledgment
        pendingAcknowledgments.set(messageId, {
          sender: username,
          recipient: data.to,
          message: data.text,
          timestamp: new Date()
        });

        if (recipient && recipient.readyState === WebSocket.OPEN) {
          // Recipient online - send immediately
          recipient.send(JSON.stringify({
            type: 'message',
            id: messageId,
            from: username,
            text: data.text,
            timestamp,
            status: 'delivering'
          }));

          // Set delivery timeout (30 seconds)
          const deliveryTimeout = setTimeout(async () => {
            if (pendingAcknowledgments.has(messageId)) {
              console.log(`Delivery timeout for message ${messageId}`);
              
              // Update status in DB
              await db.collection(collections.MESSAGES).updateOne(
                { id: messageId },
                { $set: { status: 'failed', failedAt: new Date() } }
              );
              
              pendingAcknowledgments.delete(messageId);
              notifySender(username, messageId, 'failed', 'Delivery timeout');
            }
          }, 30000);

          // Store timeout reference
          pendingAcknowledgments.get(messageId).timeout = deliveryTimeout;
        } else {
          // Recipient offline - queue message
          await db.collection(collections.QUEUED_MESSAGES).insertOne({
            ...messageDoc,
            queueTimestamp: new Date()
          });

          console.log(`Queued message ${messageId} for ${data.to}`);

          // Notify sender
          ws.send(JSON.stringify({
            type: 'delivery_status',
            messageId: messageId,
            status: 'queued',
            timestamp: new Date().toISOString()
          }));
        }

        // Send preliminary acknowledgment
        ws.send(JSON.stringify({
          type: 'ack',
          messageId: messageId,
          status: recipient ? 'delivering' : 'queued',
          timestamp: new Date().toISOString()
        }));
        return;
      }

      // Handle acknowledgments
      if (data.type === 'ack') {
        await handleAcknowledgment(data.messageId, username);
        return;
      }

      // Handle read receipts
      if (data.type === 'read_receipt') {
        await handleReadReceipt(data.messageId, username);
        return;
      }

    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        timestamp: new Date().toISOString()
      }));
    }
  });

  ws.on('close', async () => {
    if (username) {
      activeConnections.delete(username);
      console.log(`${username} disconnected`);

      // Update user status in DB
      if (db) {
        await db.collection(collections.USERS).updateOne(
          { username },
          { $set: { online: false, lastSeen: new Date() } }
        );
      }

      broadcastUserList();
    }
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error for ${username || 'unknown'}:`, error);
  });
});

// Helper functions
async function handleAcknowledgment(messageId, username) {
  if (!messageId || !pendingAcknowledgments.has(messageId)) return;

  const msg = pendingAcknowledgments.get(messageId);
  console.log(`Message ${messageId} acknowledged by ${username}`);

  // Clear delivery timeout
  if (msg.timeout) clearTimeout(msg.timeout);

  // Update message status in DB
  if (db) {
    await db.collection(collections.MESSAGES).updateOne(
      { id: messageId },
      { $set: { status: 'delivered', deliveredAt: new Date() } }
    );
  }

  // Notify sender
  notifySender(msg.sender, messageId, 'delivered');

  pendingAcknowledgments.delete(messageId);
}

async function handleReadReceipt(messageId, username) {
  if (!messageId || !pendingAcknowledgments.has(messageId)) return;

  const msg = pendingAcknowledgments.get(messageId);
  console.log(`Message ${messageId} read by ${username}`);

  // Update message status in DB
  if (db) {
    await db.collection(collections.MESSAGES).updateOne(
      { id: messageId },
      { $set: { status: 'read', readAt: new Date() } }
    );
  }

  notifySender(msg.sender, messageId, 'read');
}

function notifySender(sender, messageId, status, reason) {
  if (activeConnections.has(sender)) {
    activeConnections.get(sender).send(JSON.stringify({
      type: 'delivery_status',
      messageId: messageId,
      status: status,
      reason: reason,
      timestamp: new Date().toISOString()
    }));
  }
}

async function broadcastUserList() {
  const userList = Array.from(activeConnections.keys());
  const onlineUsers = await db.collection(collections.USERS)
    .find({ username: { $in: userList } })
    .project({ username: 1, lastSeen: 1 })
    .toArray();

  const offlineUsers = await db.collection(collections.USERS)
    .find({ username: { $nin: userList }, lastSeen: { $gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } })
    .sort({ lastSeen: -1 })
    .limit(50)
    .project({ username: 1, lastSeen: 1 })
    .toArray();

  const message = JSON.stringify({
    type: 'user_list',
    online: onlineUsers,
    offline: offlineUsers,
    timestamp: new Date().toISOString()
  });

  activeConnections.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Start server
connectToMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  });
});

// Handle process termination
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing server...');
  
  // Update all online users to offline
  if (db) {
    await db.collection(collections.USERS).updateMany(
      { username: { $in: Array.from(activeConnections.keys()) } },
      { $set: { online: false, lastSeen: new Date() } }
    );
  }
  
  server.close(() => {
    console.log('Server closed');
    if (client) client.close();
    process.exit(0);
  });
});