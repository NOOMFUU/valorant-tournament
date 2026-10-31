const mongoose = require('mongoose');

const tournamentEntrySchema = new mongoose.Schema({
  tournament: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true, index: true },
  team: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  registration: { type: mongoose.Schema.Types.ObjectId, ref: 'Registration', default: null },
  status: {
    type: String,
    enum: ['registered', 'withdrawn', 'disqualified'],
    default: 'registered'
  }
}, { timestamps: true });

tournamentEntrySchema.index({ tournament: 1, team: 1 }, { unique: true });

module.exports = mongoose.model('TournamentEntry', tournamentEntrySchema);
