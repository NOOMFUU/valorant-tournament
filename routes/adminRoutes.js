const express = require('express');
const router = express.Router();

// Import Models
const AdminLog = require('../models/AdminLog');

// --- MIDDLEWARE ---
const auth = require('../middleware/auth');
const { logAdminAction } = require('../utils/helpers');

// --- ROUTES ---

// Get Admin Logs
router.get('/admin/logs', auth(['admin']), async (req, res) => {
    try {
        const logs = await AdminLog.find().sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Admin Broadcast Message
router.post('/admin/broadcast', auth(['admin']), async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ msg: 'Message required' });
        
        const io = req.app.get('io');
        if (io) io.emit('notification', { msg: `📢 ADMIN: ${message}` });
        
        await logAdminAction(req, 'BROADCAST', 'All Users', { message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;
