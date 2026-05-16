const mongoose = require('mongoose');

// Player performance per map
const PlayerStatSchema = new mongoose.Schema({
    playerName: { type: String, required: true },
    playerTag: { type: String, required: true },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
    mapName: { type: String, required: true },
    kills: { type: Number, default: 0 },
    deaths: { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    acs: { type: Number, default: 0 },
    adr: { type: Number, default: 0 },
    kast: { type: Number, default: 0 },
    firstKills: { type: Number, default: 0 },
    firstDeaths: { type: Number, default: 0 },
    agent: { type: String, default: '' },
    won: { type: Boolean, default: false }
}, { timestamps: true });

PlayerStatSchema.index({ matchId: 1, mapName: 1, playerName: 1 });
PlayerStatSchema.index({ teamId: 1, tournamentId: 1 });
PlayerStatSchema.index({ tournamentId: 1 });

module.exports = mongoose.model('PlayerStat', PlayerStatSchema);
