// websocket_chat/index.js
const WebSocket = require('ws');
const http = require('http');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const User = require('./model/User');
const Message = require('./model/Message'); // Assuming you have a Message model
dotenv.config();

// Configuration
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = 'SAKPHEADATABASE';

// Create HTTP server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Store active connections
const activeConnections = new Map();
const pendingAcknowledgments = new Map();

// Connect to MongoDB
async function connectToMongo() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      dbName: DB_NAME,
    });
    console.log('Connected to MongoDB with Mongoose');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// HTTP request handler
server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    connectedUsers: activeConnections.size,
    uptime: process.uptime()
  }));
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let username = '';
  let userData = null;

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'register':
          await handleRegistration(ws, data, req);
          break;

        case 'message':
          await handleMessage(ws, data);
          break;

        case 'ack':
          handleAcknowledgment(data);
          break;

        case 'typing':
          handleTypingIndicator(data);
          break;

        case 'get_history':
          await handleHistoryRequest(ws, data);
          break;

        default:
          console.warn('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Message processing error:', error);
      sendError(ws, 'Error processing message');
    }
  });

  // Handle connection close
  ws.on('close', async () => {
    await handleDisconnection();
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Helper functions
  async function handleRegistration(ws, data, req) {
    username = data.username;
    activeConnections.set(username, ws);

    userData = await User.findOneAndUpdate(
      { username },
      {
        $set: {
          ipAddress: req.socket.remoteAddress,
          lastSeen: new Date(),
          online: true
        },
        $setOnInsert: {
          firstSeen: new Date()
        }
      },
      { upsert: true, new: true }
    );

    console.log(`${username} connected from ${req.socket.remoteAddress}`);
    broadcastUserList();

    // Send queued messages if any
    await deliverQueuedMessages(username);
  }

  async function handleMessage(ws, data) {
    const messageId = data.id || uuidv4();
    const recipient = activeConnections.get(data.to);
    const timestamp = new Date();

    // Create message document
    const messageDoc = new Message({
      id: messageId,
      from: username,
      to: data.to,
      text: data.text,
      timestamp,
      status: recipient ? 'delivering' : 'queued'
    });

    // Save to database
    await messageDoc.save();

    if (recipient && recipient.readyState === WebSocket.OPEN) {
      // Recipient is online - deliver immediately
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
          await Message.updateOne(
            { id: messageId },
            { $set: { status: 'failed', failedAt: new Date() } }
          );
          pendingAcknowledgments.delete(messageId);
          notifySender(username, messageId, 'failed', 'Delivery timeout');
        }
      }, 30000);

      pendingAcknowledgments.set(messageId, {
        ...messageDoc.toObject(),
        timeout: deliveryTimeout
      });
    } else {
      // Recipient offline - just save to database (status is already 'queued')
      console.log(`Message queued for offline user ${data.to}`);
    }

    // Send acknowledgment to sender
    ws.send(JSON.stringify({
      type: 'ack',
      messageId: messageId,
      status: recipient ? 'delivering' : 'queued',
      timestamp: new Date().toISOString()
    }));
  }

  function handleAcknowledgment(data) {
    const msg = pendingAcknowledgments.get(data.messageId);
    if (msg) {
      // Clear timeout and update status
      if (msg.timeout) clearTimeout(msg.timeout);
      
      Message.updateOne(
        { id: data.messageId },
        { $set: { status: 'delivered', deliveredAt: new Date() } }
      ).catch(console.error);

      pendingAcknowledgments.delete(data.messageId);
      notifySender(msg.from, data.messageId, 'delivered');
    }
  }

  function handleTypingIndicator(data) {
    const recipient = activeConnections.get(data.to);
    if (recipient && recipient.readyState === WebSocket.OPEN) {
      recipient.send(JSON.stringify({
        type: 'typing',
        from: username,
        isTyping: data.isTyping
      }));
    }
  }

  async function handleHistoryRequest(ws, data) {
    try {
      const messages = await Message.find({
        $or: [
          { from: data.user1, to: data.user2 },
          { from: data.user2, to: data.user1 }
        ]
      })
      .sort({ timestamp: -1 })
      .limit(data.limit || 50)
      .lean();

      ws.send(JSON.stringify({
        type: 'message_history',
        messages: messages.reverse()
      }));
    } catch (error) {
      console.error('Error fetching message history:', error);
      sendError(ws, 'Error loading message history');
    }
  }

  async function deliverQueuedMessages(username) {
    try {
      const queuedMessages = await Message.find({
        to: username,
        status: 'queued'
      });

      if (queuedMessages.length > 0) {
        const ws = activeConnections.get(username);
        if (ws && ws.readyState === WebSocket.OPEN) {
          queuedMessages.forEach(async (msg) => {
            ws.send(JSON.stringify({
              type: 'message',
              id: msg.id,
              from: msg.from,
              text: msg.text,
              timestamp: msg.timestamp,
              status: 'delivering'
            }));

            // Update status in database
            await Message.updateOne(
              { id: msg.id },
              { $set: { status: 'delivering' } }
            );
          });
        }
      }
    } catch (error) {
      console.error('Error delivering queued messages:', error);
    }
  }

  async function handleDisconnection() {
    if (username) {
      activeConnections.delete(username);
      await User.updateOne(
        { username },
        { $set: { online: false, lastSeen: new Date() } }
      );
      broadcastUserList();
      console.log(`${username} disconnected`);
    }
  }

  function notifySender(sender, messageId, status, reason) {
    const senderWs = activeConnections.get(sender);
    if (senderWs && senderWs.readyState === WebSocket.OPEN) {
      senderWs.send(JSON.stringify({
        type: 'delivery_status',
        messageId,
        status,
        reason,
        timestamp: new Date().toISOString()
      }));
    }
  }

  function sendError(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message,
        timestamp: new Date().toISOString()
      }));
    }
  }
});

// Broadcast user list to all connected clients
async function broadcastUserList() {
  try {
    const users = await User.find({})
      .sort({ lastSeen: -1 })
      .limit(100)
      .select('username online lastSeen')
      .lean();

    const message = JSON.stringify({
      type: 'user_list',
      users,
      timestamp: new Date().toISOString()
    });

    activeConnections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  } catch (error) {
    console.error('Error broadcasting user list:', error);
  }
}

// Cleanup on process termination
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing server...');
  
  // Update all online users to offline
  await User.updateMany(
    { username: { $in: Array.from(activeConnections.keys()) } },
    { $set: { online: false, lastSeen: new Date() } }
  );
  
  server.close(() => {
    mongoose.connection.close();
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server
connectToMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  });
});