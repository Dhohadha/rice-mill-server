const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true }, // MAC Address or unique ID
  deviceName: { type: String, default: 'Rice Mill' },
  ownerUid: { type: String }, // User UID who owns this device
  isActive: { type: Boolean, default: true },
  relays: [{ name: { type: String }, state: { type: Boolean, default: false } }],
  capacitorCount: { type: Number, default: 10, min: 1, max: 12 },
  deviceType: { type: String, enum: ['EMS', 'APFC'], default: 'EMS' }
}, { timestamps: true });

module.exports = mongoose.model('Device', deviceSchema);
