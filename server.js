const WebSocket = require('ws');
const http = require('http');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'chat_app';

mongoose.connect(MONGO_URI, {
  dbName: DB_NAME,
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schemas
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now },
  lastSeen: Date,
  online: Boolean,
  ipAddress: String
});

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['queued', 'delivering', 'delivered', 'read', 'failed'], default: 'queued' },
  deliveredAt: Date,
  readAt: Date
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// WebSocket Server Setup
const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// In-Memory Stores
const activeConnections = new Map(); // username -> WebSocket
const typingStatus = new Map();      // username -> { typingTo: username, isTyping: boolean }

// HTTP Health Check
server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    users: activeConnections.size,
    uptime: process.uptime()
  }));
});

// WebSocket Connection Handler
wss.on('connection', (ws, req) => {
  let username = '';

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'register':
          await handleRegistration(ws, data, req);
          break;

        case 'message':
          await handleMessage(data);
          break;

        case 'ack':
          await handleAcknowledgment(data);
          break;

        case 'typing':
          handleTyping(data);
          break;

        case 'read_receipt':
          await handleReadReceipt(data);
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

  ws.on('close', async () => {
    await handleDisconnection();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Helper Functions
  async function handleRegistration(ws, data, req) {
    username = data.username;
    activeConnections.set(username, ws);

    // Create or update user in database
    const user = await User.findOneAndUpdate(
      { username },
      {
        $set: {
          lastSeen: new Date(),
          online: true,
          ipAddress: req.socket.remoteAddress
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    console.log(`${username} connected (IP: ${req.socket.remoteAddress})`);
    broadcastUserList();

    // Deliver any queued messages
    await deliverQueuedMessages(username);
  }

  async function handleMessage(data) {
    const messageId = data.id || uuidv4();
    const recipient = activeConnections.get(data.to);
    const timestamp = new Date();

    // Create message document
    const message = new Message({
      id: messageId,
      from: username,
      to: data.to,
      text: data.text,
      timestamp,
      status: recipient ? 'delivering' : 'queued'
    });

    // Save to database
    await message.save();

    if (recipient && recipient.readyState === WebSocket.OPEN) {
      // Recipient is online - deliver immediately
      recipient.send(JSON.stringify({
        type: 'message',
        id: messageId,
        from: username,
        text: data.text,
        timestamp: timestamp.toISOString(),
        status: 'delivering'
      }));

      // Set delivery timeout (30 seconds)
      const timeout = setTimeout(async () => {
        if (await Message.exists({ id: messageId, status: 'delivering' })) {
          await Message.updateOne(
            { id: messageId },
            { $set: { status: 'failed', deliveredAt: new Date() } }
          );
          notifySender(username, messageId, 'failed', 'Delivery timeout');
        }
      }, 30000);

      // Store timeout reference
      message.timeout = timeout;
    } else {
      console.log(`Message queued for offline user ${data.to}`);
    }

    // Send acknowledgment to sender
    users.get(username)?.send(JSON.stringify({
      type: 'ack',
      messageId,
      status: recipient ? 'delivering' : 'queued',
      timestamp: new Date().toISOString()
    }));
  }

  async function handleAcknowledgment(data) {
    const message = await Message.findOne({ id: data.messageId });
    if (message) {
      // Update message status
      await Message.updateOne(
        { id: data.messageId },
        { $set: { status: 'delivered', deliveredAt: new Date() } }
      );

      // Notify sender
      notifySender(message.from, data.messageId, 'delivered');
    }
  }

  async function handleReadReceipt(data) {
    await Message.updateOne(
      { id: data.messageId },
      { $set: { status: 'read', readAt: new Date() } }
    );
    
    notifySender(data.from, data.messageId, 'read');
  }

  function handleTyping(data) {
    const recipient = activeConnections.get(data.to);
    if (recipient && recipient.readyState === WebSocket.OPEN) {
      // Update typing status
      typingStatus.set(username, {
        typingTo: data.to,
        isTyping: data.isTyping,
        timestamp: new Date()
      });

      // Forward to recipient
      recipient.send(JSON.stringify({
        type: 'typing',
        from: username,
        isTyping: data.isTyping
      }));

      // Auto-clear after 3 seconds
      if (data.isTyping) {
        setTimeout(() => {
          const status = typingStatus.get(username);
          if (status && status.isTyping && status.typingTo === data.to) {
            recipient.send(JSON.stringify({
              type: 'typing',
              from: username,
              isTyping: false
            }));
          }
        }, 3000);
      }
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
      .sort({ timestamp: 1 }) // Oldest first
      .limit(data.limit || 50)
      .lean();

      ws.send(JSON.stringify({
        type: 'message_history',
        messages: messages.map(msg => ({
          id: msg.id,
          from: msg.from,
          to: msg.to,
          text: msg.text,
          timestamp: msg.timestamp.toISOString(),
          status: msg.status
        }))
      }));
    } catch (error) {
      console.error('Error fetching history:', error);
      sendError(ws, 'Failed to load message history');
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
          for (const msg of queuedMessages) {
            ws.send(JSON.stringify({
              type: 'message',
              id: msg.id,
              from: msg.from,
              text: msg.text,
              timestamp: msg.timestamp.toISOString(),
              status: 'delivering'
            }));

            // Update status in database
            await Message.updateOne(
              { id: msg.id },
              { $set: { status: 'delivering' } }
            );
          }
        }
      }
    } catch (error) {
      console.error('Error delivering queued messages:', error);
    }
  }

  async function handleDisconnection() {
    if (username) {
      activeConnections.delete(username);
      typingStatus.delete(username);

      // Update user status in database
      await User.updateOne(
        { username },
        { $set: { online: false, lastSeen: new Date() } }
      );

      console.log(`${username} disconnected`);
      broadcastUserList();
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
      users: users.map(user => ({
        username: user.username,
        online: user.online,
        lastSeen: user.lastSeen.toISOString()
      })),
      timestamp: new Date().toISOString()
    });

    activeConnections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  } catch (error) {
    console.error('Error broadcasting user list:', error);
  }
}

// Cleanup on shutdown
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
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});