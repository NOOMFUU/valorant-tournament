const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema({
  tournament: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
  order: { type: Number, required: true },
  name: { type: String, required: true, trim: true },
  // ชนิดเดียวกับ stages[].type ในระบบเดิม เพื่อให้ migrate ได้โดยไม่สูญข้อมูล
  type: {
    type: String,
    enum: ['round_robin', 'single_elim', 'double_elim', 'triple_elim', 'swiss', 'gsl', 'cross_group'],
    required: true
  },
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  sourceStage: { type: mongoose.Schema.Types.ObjectId, ref: 'Stage', default: null },
  status: {
    type: String,
    enum: ['pending', 'active', 'completed'],
    default: 'pending'
  }
}, { timestamps: true });

stageSchema.index({ tournament: 1, order: 1 }, { unique: true });

module.exports = mongoose.model('Stage', stageSchema);
