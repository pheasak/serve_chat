const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Store active connections and data
const users = new Map();          // username -> WebSocket
const messageQueue = new Map();   // username -> [messages]
const pendingAcknowledgments = new Map(); // messageId -> messageData
const typingStatus = new Map();   // username -> { typingTo: username, timestamp }

// HTTP request handler
server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    connectedUsers: users.size,
    uptime: process.uptime()
  }));
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  let username = '';
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      switch (data.type) {
        case 'register':
          await handleRegistration(ws, data);
          break;
          
        case 'message':
          await handleMessage(data);
          break;
          
        case 'ack':
          handleAcknowledgment(data);
          break;
          
        case 'typing':
          handleTyping(data);
          break;
          
        case 'get_history':
          handleHistoryRequest(ws, data);
          break;
          
        default:
          console.warn('Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('Message processing error:', error);
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    handleDisconnection();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Helper functions
  async function handleRegistration(ws, data) {
    username = data.username;
    users.set(username, ws);
    console.log(`${username} connected`);
    
    // Deliver queued messages
    if (messageQueue.has(username)) {
      const pendingMessages = messageQueue.get(username);
      pendingMessages.forEach(msg => {
        ws.send(JSON.stringify(msg));
      });
      messageQueue.delete(username);
    }
    
    broadcastUserList();
  }

  async function handleMessage(data) {
    const messageId = data.id || uuidv4();
    const recipient = users.get(data.to);
    const messageData = {
      type: 'message',
      id: messageId,
      from: username,
      to: data.to,
      text: data.text,
      timestamp: new Date().toISOString()
    };
    
    // Store for acknowledgment tracking
    pendingAcknowledgments.set(messageId, {
      sender: username,
      recipient: data.to,
      message: data.text,
      timestamp: new Date()
    });

    if (recipient && recipient.readyState === WebSocket.OPEN) {
      // Recipient online - send immediately
      recipient.send(JSON.stringify(messageData));
      
      // Set delivery timeout (30 seconds)
      setTimeout(() => {
        if (pendingAcknowledgments.has(messageId)) {
          console.log(`Delivery timeout for ${messageId}`);
          pendingAcknowledgments.delete(messageId);
          notifySender(username, messageId, 'failed', 'Delivery timeout');
        }
      }, 30000);
    } else {
      // Recipient offline - queue message
      if (!messageQueue.has(data.to)) {
        messageQueue.set(data.to, []);
      }
      messageQueue.get(data.to).push(messageData);
      console.log(`Queued message for ${data.to}`);
      
      // Notify sender that message is queued
      notifySender(username, messageId, 'queued');
    }
    
    // Send preliminary acknowledgment
    users.get(username)?.send(JSON.stringify({
      type: 'ack',
      messageId: messageId,
      status: recipient ? 'delivering' : 'queued',
      timestamp: new Date().toISOString()
    }));
  }

  function handleAcknowledgment(data) {
    if (pendingAcknowledgments.has(data.messageId)) {
      const msg = pendingAcknowledgments.get(data.messageId);
      console.log(`Message ${data.messageId} acknowledged by ${username}`);
      
      // Notify original sender
      notifySender(msg.sender, data.messageId, 'delivered');
      
      pendingAcknowledgments.delete(data.messageId);
    }
  }

  function handleTyping(data) {
    const recipient = users.get(data.to);
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
      
      // Auto-clear after 3 seconds if still typing
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

  function handleHistoryRequest(ws, data) {
    // In a real app, you would fetch from database
    // Here we just return an empty array
    ws.send(JSON.stringify({
      type: 'message_history',
      messages: []
    }));
  }

  function handleDisconnection() {
    if (username) {
      users.delete(username);
      typingStatus.delete(username);
      console.log(`${username} disconnected`);
      broadcastUserList();
    }
  }

  function notifySender(sender, messageId, status, reason) {
    const senderWs = users.get(sender);
    if (senderWs && senderWs.readyState === WebSocket.OPEN) {
      senderWs.send(JSON.stringify({
        type: 'delivery_status',
        messageId: messageId,
        status: status,
        reason: reason,
        timestamp: new Date().toISOString()
      }));
    }
  }

  function sendError(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        message: message,
        timestamp: new Date().toISOString()
      }));
    }
  }
});

// Broadcast user list to all connected clients
function broadcastUserList() {
  const userList = Array.from(users.keys());
  const message = JSON.stringify({
    type: 'user_list',
    users: userList,
    timestamp: new Date().toISOString()
  });
  
  users.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
});

// Cleanup on exit
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});