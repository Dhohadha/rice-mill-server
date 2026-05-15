const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  userEmail: { type: String, required: true, index: true },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DeviceToken', deviceTokenSchema);
