const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

// Get notifications for logged in user/team
router.get('/notifications', auth(['admin', 'team']), async (req, res) => {
    try {
        const query = {
            $or: [
                { globalRole: 'all' }
            ]
        };

        if (req.user.role === 'admin') {
            query.$or.push({ globalRole: 'admin' });
            query.$or.push({ recipientId: req.user.id });
        } else if (req.user.role === 'team') {
            query.$or.push({ globalRole: 'team' });
            query.$or.push({ recipientId: req.user.teamId });
        }

        const limit = parseInt(req.query.limit) || 20;
        const notifications = await Notification.find(query).sort({ createdAt: -1 }).limit(limit);
        res.json(notifications);
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// Mark notification as read
router.put('/notifications/:id/read', auth(['admin', 'team']), async (req, res) => {
    try {
        const notification = await Notification.findByIdAndUpdate(req.params.id, { isRead: true }, { new: true });
        if (!notification) return res.status(404).json({ msg: 'Notification not found' });
        res.json({ success: true, notification });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// Mark all as read
router.put('/notifications/read/all', auth(['admin', 'team']), async (req, res) => {
    try {
        const query = {
            $or: [
                { globalRole: 'all' }
            ]
        };

        if (req.user.role === 'admin') {
            query.$or.push({ globalRole: 'admin' });
            query.$or.push({ recipientId: req.user.id });
        } else if (req.user.role === 'team') {
            query.$or.push({ globalRole: 'team' });
            query.$or.push({ recipientId: req.user.teamId });
        }

        await Notification.updateMany(query, { isRead: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

module.exports = router;
