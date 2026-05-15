const mongoose = require('mongoose');

const dailyUsageSchema = new mongoose.Schema({
  date: { type: Date, required: true }, // Set to the start of the day (00:00:00)
  deviceId: { type: String, required: true },
  totalKWh: { type: Number, required: true, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Compound unique index for date and deviceId
dailyUsageSchema.index({ date: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('DailyUsage', dailyUsageSchema);
