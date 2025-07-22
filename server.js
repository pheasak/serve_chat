const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Railway provides PORT environment variable
const PORT = process.env.PORT || 8080;

// Create HTTP server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Store active connections and messages
const users = new Map();
const messageQueue = new Map();
const pendingAcknowledgments = new Map();

// Handle HTTP requests (optional)
server.on('request', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

wss.on('connection', (ws, req) => {
  // Handle CORS if needed
  const origin = req.headers.origin;
  if (origin) {
    ws.upgradeReq.headers['Access-Control-Allow-Origin'] = origin;
  }

  let username = '';
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register') {
        username = data.username;
        users.set(username, ws);
        console.log(`${username} connected from ${req.socket.remoteAddress}`);
        
        // Deliver queued messages
        if (messageQueue.has(username)) {
          const pendingMessages = messageQueue.get(username);
          pendingMessages.forEach(msg => {
            ws.send(JSON.stringify(msg));
          });
          messageQueue.delete(username);
        }
        
        broadcastUserList();
        return;
      }
      
      if (data.type === 'message') {
        const messageId = data.id || uuidv4();
        const recipient = users.get(data.to);
        const messageData = {
          type: 'message',
          id: messageId,
          from: username,
          text: data.text,
          timestamp: new Date().toISOString()
        };
        
        // Track for acknowledgment
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
          const deliveryTimeout = setTimeout(() => {
            if (pendingAcknowledgments.has(messageId)) {
              console.log(`Delivery timeout for message ${messageId}`);
              pendingAcknowledgments.delete(messageId);
              notifySender(username, messageId, 'failed', 'Delivery timeout');
            }
          }, 30000);

          // Store timeout reference
          pendingAcknowledgments.get(messageId).timeout = deliveryTimeout;
        } else {
          // Recipient offline - queue message
          if (!messageQueue.has(data.to)) {
            messageQueue.set(data.to, []);
          }
          messageQueue.get(data.to).push(messageData);
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
      
      if (data.type === 'ack') {
        handleAcknowledgment(data.messageId, username);
        return;
      }
      
      if (data.type === 'read_receipt') {
        handleReadReceipt(data.messageId, username);
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

  ws.on('close', () => {
    if (username) {
      users.delete(username);
      console.log(`${username} disconnected`);
      broadcastUserList();
    }
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${username || 'unknown'}:`, error);
  });
});

// Helper functions
function handleAcknowledgment(messageId, username) {
  if (!messageId || !pendingAcknowledgments.has(messageId)) return;
  
  const msg = pendingAcknowledgments.get(messageId);
  console.log(`Message ${messageId} acknowledged by ${username}`);
  
  // Clear delivery timeout
  if (msg.timeout) clearTimeout(msg.timeout);
  
  // Notify sender
  notifySender(msg.sender, messageId, 'delivered');
  
  pendingAcknowledgments.delete(messageId);
}

function handleReadReceipt(messageId, username) {
  if (!messageId || !pendingAcknowledgments.has(messageId)) return;
  
  const msg = pendingAcknowledgments.get(messageId);
  console.log(`Message ${messageId} read by ${username}`);
  
  notifySender(msg.sender, messageId, 'read');
}

function notifySender(sender, messageId, status, reason) {
  if (users.has(sender)) {
    users.get(sender).send(JSON.stringify({
      type: 'delivery_status',
      messageId: messageId,
      status: status,
      reason: reason,
      timestamp: new Date().toISOString()
    }));
  }
}

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

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});