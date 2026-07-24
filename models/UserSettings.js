const mongoose = require('mongoose');

const userSettingsSchema = new mongoose.Schema({
  userEmail: { type: String, required: true, unique: true },
  cmdLimit: { type: Number, default: 150 },
  cmdMaxGauge: { type: Number, default: 250 },
  powerLimit: { type: Number, default: 150 },
  powerMaxGauge: { type: Number, default: 250 },
  pfLimit: { type: Number, default: 0.85 },
  googleRefreshToken: { type: String, default: null },
  isDriveConnected: { type: Boolean, default: false },
  isEmailReportEnabled: { type: Boolean, default: false },
  reportEmail: { type: String, default: null }
});

module.exports = mongoose.model('UserSettings', userSettingsSchema);
