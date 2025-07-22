require('dotenv').config(); // Load .env config first
const WebSocket = require('ws');
const http = require('http');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');

// Confirm MONGO_URI is loaded
console.log('MONGO_URI:', process.env.MONGO_URI);

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect('mongodb+srv://jakihotta:UXdaFfISleVYLDmx@cluster0.c8sb4dq.mongodb.net/SAKPHEADATABASE?retryWrites=true&w=majority', {
      dbName: 'chat_app',
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      retryWrites: true,
      w: 'majority'
    });
    console.log('MongoDB Atlas connected successfully');

    mongoose.connection.on('error', err => {
      console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('MongoDB disconnected, attempting to reconnect...');
      setTimeout(connectDB, 5000);
    });

  } catch (err) {
    console.error('Initial MongoDB connection failed:', err);
    process.exit(1);
  }
};

connectDB();

// Schemas
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
  status: {
    type: String,
    enum: ['queued', 'delivering', 'delivered', 'read', 'failed'],
    default: 'queued'
  },
  deliveredAt: Date,
  readAt: Date
});

messageSchema.index({ from: 1, to: 1, timestamp: 1 });
messageSchema.index({ to: 1, status: 1 });
userSchema.index({ username: 1 }, { unique: true });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// WebSocket setup
const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({
  server,
  clientTracking: true,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    threshold: 1024,
    concurrencyLimit: 10
  }
});

const activeConnections = new Map();
const messageTimeouts = new Map();
const typingStatus = new Map();

// Health check route
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      connections: activeConnections.size,
      uptime: process.uptime(),
      dbState: mongoose.connection.readyState
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (!data.type) throw new Error('Invalid message format');

      switch (data.type) {
        case 'register':
          await handleRegistration(ws, data);
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
          sendError(ws, 'Unknown message type');
      }
    } catch (error) {
      console.error('Message processing error:', error);
      sendError(ws, error.message);
    }
  });

  // Your existing ping/pong logic is below...
});

// Keep-alive ping
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      console.log('Terminating inactive connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Server startup
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
  process.on(signal, async () => {
    console.log(`\n${signal} received. Closing server...`);
    if (activeConnections.size > 0) {
      await User.updateMany(
        { username: { $in: Array.from(activeConnections.keys()) } },
        { $set: { online: false, lastSeen: new Date() } }
      );
    }

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    });

    server.close(async () => {
      await mongoose.connection.close();
      console.log('Server closed gracefully');
      process.exit(0);
    });
  });
});
