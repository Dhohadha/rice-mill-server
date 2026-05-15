const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  deviceId: { type: String, default: 'RICE_MILL_001', index: true },
  userEmail: { type: String, required: true, index: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  type: { type: String, enum: ['CMD', 'POWER', 'PF', 'INFO'], default: 'INFO' },
  timestamp: { type: Date, default: Date.now },
  read: { type: Boolean, default: false }
});

module.exports = mongoose.model('Notification', notificationSchema);
