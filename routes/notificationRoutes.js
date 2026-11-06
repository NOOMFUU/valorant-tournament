const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');
const auth = require('../middleware/auth');

// JWT ของทีมและ admin เก็บ id ไว้ที่ req.user.id (ดู routes/teamRoutes.js /login)
function buildOwnerQuery(user) {
    const or = [{ globalRole: 'all' }];
    if (user.role === 'admin') {
        or.push({ globalRole: 'admin' });
        or.push({ recipientId: user.id });
    } else if (user.role === 'team') {
        or.push({ globalRole: 'team' });
        or.push({ recipientId: user.id });
    }
    return { $or: or };
}

// Get notifications for logged in user/team
router.get('/notifications', auth(['admin', 'team']), async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const notifications = await Notification.find(buildOwnerQuery(req.user)).sort({ createdAt: -1 }).limit(limit);
        res.json(notifications);
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// Mark notification as read (เฉพาะที่เป็นของผู้ใช้เท่านั้น)
router.put('/notifications/:id/read', auth(['admin', 'team']), async (req, res) => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, ...buildOwnerQuery(req.user) },
            { isRead: true },
            { new: true }
        );
        if (!notification) return res.status(404).json({ msg: 'Notification not found' });
        res.json({ success: true, notification });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// Mark all as read
router.put('/notifications/read/all', auth(['admin', 'team']), async (req, res) => {
    try {
        await Notification.updateMany(buildOwnerQuery(req.user), { isRead: true });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

module.exports = router;
