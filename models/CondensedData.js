const mongoose = require('mongoose');

const condensedDataSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  KVA: Number,
  KW: Number,
  PF: Number,
  KWH: Number,
  timestamp: { type: Date, default: Date.now, index: true }
});

// TTL Index to delete condensed data older than 30 days
condensedDataSchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });

module.exports = mongoose.model('CondensedData', condensedDataSchema);
