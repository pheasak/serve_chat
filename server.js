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
      dbName: 'SAKPHEADATABASE',
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
const typingEventSchema = new mongoose.Schema({
    from: String,
    to: String,
    isTyping: Boolean,
    timestamp: { type: Date, default: Date.now }
});
const TypingEvent = mongoose.model('TypingEvent', typingEventSchema);
const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

// WebSocket setup
const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

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

// Handle new WebSocket connection
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
          handleTypingIndicator(data);
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

  ws.on('close', async () => {
    if (ws.username) {
      console.log(`${ws.username} disconnected`);
      activeConnections.delete(ws.username);
      await User.updateOne(
        { username: ws.username },
        { $set: { online: false, lastSeen: new Date() } }
      );
      broadcastUserList();
    }
  });
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

// ==== Handlers ====

async function handleRegistration(ws, data) {
  const username = data.username;
  if (!username) {
    return sendError(ws, 'Username is required for registration');
  }

  try {
    await User.updateOne(
      { username },
      {
        $set: {
          online: true,
          ipAddress: ws._socket.remoteAddress,
          lastSeen: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    activeConnections.set(username, ws);
    ws.username = username;
    console.log(`${username} registered and connected`);

    broadcastUserList();
  } catch (err) {
    console.error('Registration error:', err);
    sendError(ws, 'Registration failed');
  }
}

// In your server's broadcastUserList function
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
        online: user.online || false,
        lastSeen: user.lastSeen ? user.lastSeen.toISOString() : null
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

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'error', message }));
  }
}

async function handleMessage(data) {
  const { from, to, text } = data;

  const message = new Message({
    id: uuidv4(),
    from,
    to,
    text,
    status: 'queued'
  });

  await message.save();

  const targetWS = activeConnections.get(to);
  if (targetWS && targetWS.readyState === WebSocket.OPEN) {
    targetWS.send(JSON.stringify({
      type: 'message',
      from,
      text,
      id: message.id,
      timestamp: message.timestamp
    }));

    message.status = 'delivered';
    message.deliveredAt = new Date();
    await message.save();
  }
}

async function handleAcknowledgment(data) {
  const { id, status } = data;
  await Message.updateOne({ id }, {
    $set: {
      status,
      ...(status === 'read' && { readAt: new Date() }),
    }
  });
}

function handleTypingIndicator(data) {
    try {
        // Validate incoming data
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid typing data format');
        }

        const { to, isTyping } = data;
        
        // Validate required fields
        if (!to || typeof isTyping !== 'boolean') {
            throw new Error('Missing required fields: to or isTyping');
        }

        // Get recipient connection
        const recipient = activeConnections.get(to);
        
        // Check if recipient exists and connection is open
        if (recipient && recipient.readyState === WebSocket.OPEN) {
            // Prepare typing notification payload
            const typingNotification = JSON.stringify({
                type: 'typing',
                from: data.from,  // Make sure 'username' is available in scope
                to: data.to,
                isTyping: data.isTyping,
                timestamp: new Date().toISOString()
            });

            // Send notification
            recipient.send(typingNotification);
            
            // Log the event (optional)
            console.log(`Typing ${data.isTyping ? 'started' : 'stopped'} from ${username} to ${to}`);
            
            // Update typing status in MongoDB (optional)
            if (process.env.LOG_TYPING_EVENTS === 'true') {
                TypingEvent.create({
                    from: data.from,
                    to: data.to,
                    isTyping: data.isTyping
                }).catch(err => {
                    console.error('Failed to log typing event:', err);
                });
            }
        } else {
            console.log(`Recipient ${to} is not currently connected`);
        }
    } catch (error) {
        console.error('Error handling typing indicator:', error);
        
        // Optionally notify the sender about the error
        if (activeConnections.has(data.from)) {
            const sender = activeConnections.get(data.from);
            if (sender && sender.readyState === WebSocket.OPEN) {
                sender.send(JSON.stringify({
                    type: 'error',
                    message: 'Failed to send typing indicator',
                    originalData: data
                }));
            }
        }
    }
}

async function handleReadReceipt(data) {
  const { messageId, reader } = data;

  await Message.updateOne({ id: messageId }, {
    $set: {
      status: 'read',
      readAt: new Date()
    }
  });
}

async function handleHistoryRequest(ws, data) {
  try {
    const { from, to, limit = 50 } = data;

    // Validate input parameters
    if (!from || !to) {
      throw new Error('Both "from" and "to" parameters are required');
    }

    // Query messages between the two users
    const messages = await Message.find({
      $or: [
        { from, to },
        { from: to, to: from }
      ]
    })
    .sort({ timestamp: 1 }) // Sort by oldest first
    .limit(limit) // Apply limit to prevent overloading
    .lean() // Convert to plain JavaScript objects
    .exec(); // Execute the query

    // Format the response
    const response = {
      type: 'history',
      messages: messages.map(msg => ({
        id: msg.id,
        from: msg.from,
        to: msg.to,
        text: msg.text,
        timestamp: msg.timestamp,
        status: msg.status || 'delivered' // Default status if not set
      }))
    };

    // Send the response
    ws.send(JSON.stringify(response));

    // Log successful query
    console.log(`Sent ${messages.length} messages history between ${from} and ${to}`);
  } catch (error) {
    console.error('Error fetching message history:', error);
    
    // Send error response to client
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Failed to load message history',
      details: error.message
    }));
  }
}