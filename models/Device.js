const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true }, // MAC Address or unique ID
  deviceName: { type: String, default: 'Rice Mill' },
  ownerUid: { type: String }, // User UID who owns this device
  isActive: { type: Boolean, default: true },
  relays: [{ name: { type: String }, state: { type: Boolean, default: false } }]
}, { timestamps: true });

module.exports = mongoose.model('Device', deviceSchema);
