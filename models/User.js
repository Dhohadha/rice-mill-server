const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  uid: { type: String, required: true, unique: true }, // Firebase UID
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  role: { type: String, enum: ['Admin', 'User', 'Guest'], default: 'User' },
  fcmToken: { type: String },
  assignedDevices: [{ type: String }], // Array of MAC addresses/Device IDs
  millName: { type: String, default: 'Rice Mill' },
  isSharedUser: { type: Boolean, default: false },
  mainUserEmail: { type: String }, // Who gave them access
  sharedWith: [{ type: String }], // Emails of people they shared with
  pendingInvitations: [{
    ownerEmail: String,
    ownerName: String,
    millName: String,
    devices: [String],
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
