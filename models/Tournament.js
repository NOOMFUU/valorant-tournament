const mongoose = require('mongoose');
const crypto = require('crypto');

// Relational models: Tournament no longer embeds stages, participants or registrations.
require('./Stage');
require('./TournamentEntry');
require('./Registration');

const TournamentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: { type: String, enum: ['setup', 'active', 'finished', 'archived'], default: 'setup' },

  // ACCESS CONTROL
  // open         -> anyone can register (subject to approval setting)
  // invite_only -> must have inviteCode to see registration form
  // private      -> admin-managed teams only, no public registration
  accessType: { type: String, enum: ['open', 'invite_only', 'private'], default: 'open' },
  inviteCode: { type: String, default: '' },

  mapPool: {
    type: [String],
    default: ['Abyss', 'Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Pearl']
  },

  // REGISTRATION CONFIG
  registration: {
    isOpen: { type: Boolean, default: false },
    deadline: { type: Date },
    maxTeams: { type: Number, default: 16 },
    requiresApproval: { type: Boolean, default: true },
    description: { type: String, default: '' },
    contactDiscord: { type: String, default: '' }
  },

  // PRIZE & INFO
  prizePool: { type: String, default: '' },
  formatDescription: { type: String, default: '' },
  rules: { type: String, default: '' },

  // ARCHIVE
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date }

}, { timestamps: true, toObject: { virtuals: true }, toJSON: { virtuals: true } });

// Virtual populate references (replace legacy embedded arrays)
TournamentSchema.virtual('entries', {
  ref: 'TournamentEntry',
  localField: '_id',
  foreignField: 'tournament'
});

TournamentSchema.virtual('stages', {
  ref: 'Stage',
  localField: '_id',
  foreignField: 'tournament',
  options: { sort: { order: 1 } }
});

TournamentSchema.virtual('registrations', {
  ref: 'Registration',
  localField: '_id',
  foreignField: 'tournament'
});

// Auto-generate invite code on save if invite_only and no code set
TournamentSchema.pre('save', function(next) {
  if (this.accessType === 'invite_only' && !this.inviteCode) {
    this.inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
  }
  next();
});

module.exports = mongoose.model('Tournament', TournamentSchema);
