const mongoose = require('mongoose');
const crypto = require('crypto');

const PendingRegistrationSchema = new mongoose.Schema({
    teamName:    { type: String, required: true },
    contactName: { type: String, required: true },
    contactDiscord: { type: String, default: '' },
    members: [{
        name: String,
        riotId: String,
        role: { type: String, enum: ['Main', 'Sub', 'Coach'], default: 'Main' }
    }],
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    rejectionReason: { type: String, default: '' },
    submittedAt: { type: Date, default: Date.now },
    inviteCode: { type: String, default: '' }  // code used to access invite-only reg
}, { _id: true });

const TournamentSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: { type: String, enum: ['setup', 'active', 'finished', 'archived'], default: 'setup' },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],

    // ACCESS CONTROL
    // open         → anyone can register (subject to approval setting)
    // invite_only  → must have inviteCode to see registration form
    // private      → admin-managed teams only, no public registration
    accessType: {
        type: String,
        enum: ['open', 'invite_only', 'private'],
        default: 'open'
    },
    inviteCode: { type: String, default: '' }, // single shared code for invite_only

    mapPool: {
        type: [String],
        default: ['Abyss', 'Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Pearl']
    },

    stages: [{
        name: String,
        type: { type: String, enum: ['round_robin', 'single_elim', 'double_elim', 'triple_elim', 'swiss', 'gsl', 'cross_group'], default: 'single_elim' },
        settings: {
            defaultFormat: { type: String, enum: ['BO1', 'BO3', 'BO5'], default: 'BO1' },
            roundCount: { type: Number, default: 1 },
            swissRounds: { type: Number, default: 3 },
            randomize: { type: Boolean, default: false },
            hasThirdPlace: { type: Boolean, default: false },
            sourceStageIndex: { type: Number, default: -1 },
            advanceCount: { type: Number, default: 0 },
            qualifiedCount: { type: Number, default: 1 },
            advanceMethod: { type: String, enum: ['top_standing', 'cross_group'], default: 'top_standing' }
        },
        stageParticipants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Team' }],
        matches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Match' }]
    }],

    // REGISTRATION CONFIG
    registration: {
        isOpen: { type: Boolean, default: false },
        deadline: { type: Date },
        maxTeams: { type: Number, default: 16 },
        requiresApproval: { type: Boolean, default: true },
        description: { type: String, default: '' },
        contactDiscord: { type: String, default: '' }
    },

    // PENDING REGISTRATIONS (before admin approval)
    pendingRegistrations: [PendingRegistrationSchema],

    // PRIZE & INFO
    prizePool: { type: String, default: '' },
    formatDescription: { type: String, default: '' },
    rules: { type: String, default: '' },

    // ARCHIVE
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date }

}, { timestamps: true });

// Auto-generate invite code on save if invite_only and no code set
TournamentSchema.pre('save', function(next) {
    if (this.accessType === 'invite_only' && !this.inviteCode) {
        this.inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
    }
    next();
});

// Compound index for pending registration queries
TournamentSchema.index({ 'pendingRegistrations.status': 1, '_id': 1 });

module.exports = mongoose.model('Tournament', TournamentSchema);