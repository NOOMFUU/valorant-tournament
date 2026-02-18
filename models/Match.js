const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
    tournament: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament' },
    name: String,
    round: Number,
    matchOrder: Number,

    matchNumber: { type: Number, default: 0 },
    
    // Bracket Linking
    nextMatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    nextMatchSlot: { type: String, enum: ['teamA', 'teamB'] },
    loserMatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match' },
    loserMatchSlot: { type: String, enum: ['teamA', 'teamB'] },

    roomPassword: { type: String, default: '' },
    chat: [{ sender: String, senderId: String, message: String, timestamp: { type: Date, default: Date.now } }],
    
    teamA: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    teamB: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    
    // Snapshot of rosters at match time
    teamARoster: [{ name: String, tag: String, role: String }],
    teamBRoster: [{ name: String, tag: String, role: String }],
    
    format: { type: String, enum: ['BO1', 'BO3', 'BO5'], default: 'BO1' },
    status: { type: String, enum: ['scheduled', 'live', 'pending_approval', 'finished', 'bye', 'auto_forfeit'], default: 'scheduled' },
    
    winner: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
    
    // Scoring
    scores: [{ mapName: String, teamAScore: Number, teamBScore: Number, proofImage: String }],
    scoreSubmission: {
        submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
        tempScores: [{ mapName: String, teamAScore: Number, teamBScore: Number, proofImage: String }],
        status: { type: String, default: 'none' },
        rejectReason: String
    },

    // [NEW] CHECK-IN SYSTEM
    checkIn: {
        teamA: { type: Boolean, default: false },
        teamB: { type: Boolean, default: false },
        windowOpen: { type: Boolean, default: false }, // Admin can manual open
        lastChecked: { type: Date } // For log
    },

    // [NEW] Reschedule System
    rescheduleRequest: {
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
        proposedTime: Date,
        reason: String,
        status: { type: String, enum: ['none', 'pending', 'rejected'], default: 'none' }
    },

    // [NEW] Pause System
    pauseRequest: {
        requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
        reason: String,
        status: { type: String, enum: ['none', 'pending', 'resolved'], default: 'none' },
        timestamp: Date
    },

    // VETO SYSTEM DATA
    vetoData: {
        status: { type: String, default: 'pending' },
        mapPool: { type: [String], default: [] }, // Dynamic pool
        bannedMaps: [String],
        pickedMaps: [{ 
            map: String, 
            pickedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' }, 
            sidePicker: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
            selectedSide: String,
            teamAStartingSide: String, 
            teamBStartingSide: String
        }],
        history: [{ text: String, timestamp: { type: Date, default: Date.now } }],
        sequence: [{ act: String, team: String }],
        sequenceIndex: { type: Number, default: 0 },
        
        currentTurnStartTime: Date,
        currentTurnDeadline: Date,
        pausedRemainingTime: { type: Number, default: 0 },
        pauseStartTime: Date,
        pausedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
        teamAPauses: { type: Number, default: 0 },
        teamBPauses: { type: Number, default: 0 },
        turnTimeLimit: { type: Number, default: 45 },
        
        coinTossWinner: { type: mongoose.Schema.Types.ObjectId, ref: 'Team' },
        decisionChoice: String,
        teamAReady: { type: Boolean, default: false },
        teamBReady: { type: Boolean, default: false }
    },
    
    discordChannelId: { type: String },
    notificationSent: { type: Boolean, default: false },
    
    scheduledTime: { type: Date } 
}, { timestamps: true });

module.exports = mongoose.model('Match', MatchSchema);