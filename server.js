const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

const users = new Map();

wss.on('connection', (ws) => {
  let username = '';
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.type === 'register') {
      username = data.username;
      users.set(username, ws);
      console.log(`${username} connected`);
      broadcastUserList();
      return;
    }
    
    if (data.type === 'message') {
      const recipient = users.get(data.to);
      if (recipient && recipient.readyState === WebSocket.OPEN) {
        recipient.send(JSON.stringify({
          type: 'message',
          from: username,
          text: data.text,
          timestamp: new Date().toISOString()
        }));
      }
    }
  });

  ws.on('close', () => {
    if (username) {
      users.delete(username);
      console.log(`${username} disconnected`);
      broadcastUserList();
    }
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

console.log('WebSocket server running on ws://localhost:8080');