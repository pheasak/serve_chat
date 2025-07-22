// websocket_chat/index.js
const WebSocket = require('ws');
const http = require('http');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const User = require('./model/User');
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

// Collections
let db;

async function connectToMongo() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      dbName: DB_NAME,
    });
    db = mongoose.connection;
    console.log('Connected to MongoDB with Mongoose');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    connectedUsers: activeConnections.size,
    uptime: process.uptime()
  }));
});

wss.on('connection', (ws, req) => {
  let username = '';
  let userData = null;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'register') {
        username = data.username;
        activeConnections.set(username, ws);

        userData = await User.findOne({ username });
        if (!userData) {
          userData = await User.create({
            username,
            ipAddress: req.socket.remoteAddress,
            firstSeen: new Date(),
            lastSeen: new Date(),
            online: true
          });
        } else {
          await User.updateOne(
            { username },
            { $set: { lastSeen: new Date(), online: true } }
          );
        }

        console.log(`${username} connected`);
        broadcastUserList();
        return;
      }

      if (data.type === 'message') {
        const id = data.id || uuidv4();
        const recipient = activeConnections.get(data.to);
        const timestamp = new Date();

        const messageDoc = {
          id,
          from: username,
          to: data.to,
          text: data.text,
          timestamp,
          status: recipient ? 'delivering' : 'queued'
        };

        if (recipient) {
          recipient.send(JSON.stringify({
            type: 'message',
            id,
            from: username,
            text: data.text,
            timestamp,
            status: 'delivering'
          }));
        } else {
          console.log(`User ${data.to} offline, message queued`);
        }

        ws.send(JSON.stringify({
          type: 'ack',
          messageId: id,
          status: messageDoc.status
        }));

        pendingAcknowledgments.set(id, messageDoc);
      }

      if (data.type === 'ack') {
        const msg = pendingAcknowledgments.get(data.messageId);
        if (msg) {
          pendingAcknowledgments.delete(data.messageId);
          console.log(`Message ${data.messageId} delivered`);
        }
      }

    } catch (error) {
      console.error('Message error:', error);
    }
  });

  ws.on('close', async () => {
    if (username) {
      activeConnections.delete(username);
      await User.updateOne(
        { username },
        { $set: { online: false, lastSeen: new Date() } }
      );
      broadcastUserList();
      console.log(`${username} disconnected`);
    }
  });
});

async function broadcastUserList() {
  const users = await User.find({}, 'username lastSeen online').lean();
  const message = JSON.stringify({
    type: 'user_list',
    users
  });
  activeConnections.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
}

connectToMongo().then(() => {
  server.listen(PORT, () => {
    console.log('MONGO_URI:', process.env.MONGO_URI);
    console.log(`Server listening on port ${PORT}`);
  });
});
