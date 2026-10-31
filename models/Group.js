const mongoose = require('mongoose');

const groupSchema = new mongoose.Schema({
  stage: { type: mongoose.Schema.Types.ObjectId, ref: 'Stage', required: true, index: true },
  order: { type: Number, required: true },
  name: { type: String, required: true, trim: true }
}, { timestamps: true });

groupSchema.index({ stage: 1, order: 1 }, { unique: true });

module.exports = mongoose.model('Group', groupSchema);
