const mongoose = require('mongoose');

const AdminLogSchema = new mongoose.Schema({
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    adminUsername: String,
    action: { type: String, required: true },
    target: String,
    details: mongoose.Schema.Types.Mixed,
    ip: String
}, { timestamps: true });

module.exports = mongoose.model('AdminLog', AdminLogSchema);