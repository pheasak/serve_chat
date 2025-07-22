const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  ipAddress: String,
  firstSeen: Date,
  lastSeen: Date,
  online: Boolean
});

module.exports = mongoose.model('User', userSchema);