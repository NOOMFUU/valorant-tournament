const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
    recipientId: { type: mongoose.Schema.Types.ObjectId, refPath: 'recipientModel', required: false }, // null for broadcast
    recipientModel: { type: String, enum: ['User', 'Team'], required: false },
    type: { type: String, enum: ['info', 'warning', 'error', 'success'], default: 'info' },
    message: { type: String, required: true },
    title: { type: String },
    link: { type: String }, // Optional link to redirect
    isRead: { type: Boolean, default: false },
    globalRole: { type: String }, // e.g. 'all', 'admin', 'team' (if recipientId is null)
}, { timestamps: true });

module.exports = mongoose.model('Notification', NotificationSchema);