// model/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['queued', 'delivering', 'delivered', 'read', 'failed'], default: 'queued' },
  deliveredAt: Date,
  readAt: Date,
  failedAt: Date
});

module.exports = mongoose.model('Message', messageSchema);