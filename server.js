const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const { v4: uuidv4 } = require('uuid');

const wss = new WebSocket.Server({ port: PORT });
const users = new Map();
const messageQueue = new Map(); // Stores pending messages per user
const pendingAcknowledgments = new Map(); // Tracks messages awaiting acknowledgment

wss.on('connection', (ws) => {
  let username = '';
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register') {
        username = data.username;
        users.set(username, ws);
        console.log(`${username} connected`);
        
        // Deliver any queued messages
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
        const messageId = uuidv4();
        const recipient = users.get(data.to);
        const messageData = {
          type: 'message',
          id: messageId,
          from: username,
          text: data.text,
          timestamp: new Date().toISOString()
        };
        
        // Store message for acknowledgment tracking
        pendingAcknowledgments.set(messageId, {
          sender: username,
          recipient: data.to,
          message: data.text,
          timestamp: new Date()
        });
        
        if (recipient && recipient.readyState === WebSocket.OPEN) {
          // Recipient is online - send immediately
          recipient.send(JSON.stringify(messageData));
          
          // Schedule acknowledgment check (timeout after 30 seconds)
          setTimeout(() => {
            if (pendingAcknowledgments.has(messageId)) {
              console.log(`No acknowledgment for message ${messageId}`);
              pendingAcknowledgments.delete(messageId);
              
              // Notify sender about failed delivery
              if (users.has(username)) {
                users.get(username).send(JSON.stringify({
                  type: 'delivery_status',
                  messageId: messageId,
                  status: 'failed',
                  reason: 'No acknowledgment from recipient'
                }));
              }
            }
          }, 30000);
        } else {
          // Recipient offline - queue the message
          if (!messageQueue.has(data.to)) {
            messageQueue.set(data.to, []);
          }
          messageQueue.get(data.to).push(messageData);
          console.log(`Queued message ${messageId} for ${data.to}`);
          
          // Immediately notify sender that message is queued
          ws.send(JSON.stringify({
            type: 'delivery_status',
            messageId: messageId,
            status: 'queued',
            timestamp: new Date().toISOString()
          }));
        }
        
        // Send preliminary acknowledgment to sender
        ws.send(JSON.stringify({
          type: 'ack',
          messageId: messageId,
          status: recipient ? 'delivering' : 'queued',
          timestamp: new Date().toISOString()
        }));
        return;
      }
      
      if (data.type === 'ack') {
        // Handle acknowledgment from recipient
        if (data.messageId && pendingAcknowledgments.has(data.messageId)) {
          const msg = pendingAcknowledgments.get(data.messageId);
          console.log(`Message ${data.messageId} acknowledged by ${username}`);
          
          // Notify original sender
          if (users.has(msg.sender)) {
            users.get(msg.sender).send(JSON.stringify({
              type: 'delivery_status',
              messageId: data.messageId,
              status: 'delivered',
              timestamp: new Date().toISOString()
            }));
          }
          
          pendingAcknowledgments.delete(data.messageId);
        }
        return;
      }
      
      if (data.type === 'read_receipt') {
        // Handle read receipts
        if (data.messageId && pendingAcknowledgments.has(data.messageId)) {
          const msg = pendingAcknowledgments.get(data.messageId);
          console.log(`Message ${data.messageId} read by ${username}`);
          
          // Notify original sender
          if (users.has(msg.sender)) {
            users.get(msg.sender).send(JSON.stringify({
              type: 'read_status',
              messageId: data.messageId,
              status: 'read',
              timestamp: new Date().toISOString()
            }));
          }
        }
        return;
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
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
    console.error(`WebSocket error for ${username}:`, error);
  });
});

function broadcastUserList() {
  const userList = Array.from(users.keys());
  users.forEach((ws, username) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'user_list',
        users: userList
      }));
    }
  });
}

console.log(`WebSocket server running on port ${PORT}`);