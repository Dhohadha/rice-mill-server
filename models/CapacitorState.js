const mongoose = require('mongoose');

const capacitorStateSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, index: true },
  capacitorKey: { type: String, required: true }, // S1, S2, ..., S12
  status: { type: Boolean, default: false },
  lastChanged: { type: Date, default: Date.now },
  history: [{
    status: Boolean,
    timestamp: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

// Compound unique index for deviceId + capacitorKey
capacitorStateSchema.index({ deviceId: 1, capacitorKey: 1 }, { unique: true });

module.exports = mongoose.model('CapacitorState', capacitorStateSchema);
