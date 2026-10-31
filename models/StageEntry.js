const mongoose = require('mongoose');

const stageEntrySchema = new mongoose.Schema({
  stage: { type: mongoose.Schema.Types.ObjectId, ref: 'Stage', required: true, index: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  seed: { type: Number, default: null },
  status: {
    type: String,
    enum: ['active', 'advanced', 'eliminated'],
    default: 'active'
  },
  finalRank: { type: Number, default: null }
}, { timestamps: true });

stageEntrySchema.index({ stage: 1, team: 1 }, { unique: true });

module.exports = mongoose.model('StageEntry', stageEntrySchema);
