const mongoose = require('mongoose');

const registrationSchema = new mongoose.Schema({
  tournament: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', default: null },
  teamName: { type: String, required: true, trim: true },
  contact: { type: String, trim: true, default: '' },
  members: [{
    name: { type: String, trim: true, default: '' },
    riotId: { type: String, trim: true, default: '' },
    puuid: { type: String, trim: true, default: '' },
    role: { type: String, enum: ['Main', 'Sub', 'Coach'], default: 'Main' }
  }],
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  rejectionReason: { type: String, default: '' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Registration', registrationSchema);
