const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// Import Models
const AdminLog = require('../models/AdminLog');
const User = require('../models/User');

// --- MIDDLEWARE ---
const auth = require('../middleware/auth');
const { logAdminAction } = require('../utils/helpers');

// --- ROUTES ---

// List Admin Users
router.get('/admin/users', auth(['admin']), async (req, res) => {
    try {
        const users = await User.find({}, '-password'); // Exclude passwords
        res.json(users);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Create Admin User
router.post('/admin/users', auth(['admin']), async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ msg: 'Username and password required' });
        
        const cleanUsername = username.toLowerCase().trim();
        const existing = await User.findOne({ username: cleanUsername });
        if (existing) return res.status(400).json({ msg: 'Username already exists' });

        const newUser = new User({
            username: cleanUsername,
            password: bcrypt.hashSync(password, 10),
            role: 'admin'
        });
        await newUser.save();
        
        await logAdminAction(req, 'CREATE_ADMIN', `User ${cleanUsername}`, { createdBy: req.user.id });
        res.json({ success: true, user: { _id: newUser._id, username: newUser.username, role: 'admin' } });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Delete Admin User
router.delete('/admin/users/:id', auth(['admin']), async (req, res) => {
    try {
        // Prevent deleting yourself
        if (req.params.id === req.user.id) return res.status(400).json({ msg: 'You cannot delete your own account' });
        
        // Prevent deleting the last admin
        const adminCount = await User.countDocuments({ role: 'admin' });
        if (adminCount <= 1) return res.status(400).json({ msg: 'At least one admin account must remain' });

        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ msg: 'User not found' });

        await logAdminAction(req, 'DELETE_ADMIN', `User ${user.username}`, { deletedBy: req.user.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

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
        const { createNotification } = require('../utils/helpers');
        await createNotification(req, `📢 ADMIN: ${message}`, 'info', { globalRole: 'all' });
        
        await logAdminAction(req, 'BROADCAST', 'All Users', { message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;
