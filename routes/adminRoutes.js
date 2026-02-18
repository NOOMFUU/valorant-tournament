const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { EmbedBuilder } = require('discord.js');

// Import Models
const AdminLog = require('../models/AdminLog');
const User = require('../models/User');
const Team = require('../models/Team');

// --- MIDDLEWARE ---
const auth = require('../middleware/auth');

async function sendDiscordLog(req, title, description, fields = [], color = 0x3498db) {
    const discordClient = req.app.get('discordClient');
    const channelId = process.env.DISCORD_ADMIN_LOG_CHANNEL_ID;
    if (!channelId || !discordClient) return;
    try {
        const channel = await discordClient.channels.fetch(channelId).catch(() => null);
        if (channel) await channel.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(description).addFields(fields).setColor(color).setTimestamp()] });
    } catch (e) { console.error("Failed to send Discord log:", e); }
}

async function logAdminAction(req, action, target, details) {
    try {
        const u = await User.findById(req.user.id);
        const adminName = u ? u.username : 'Unknown';
        await AdminLog.create({ adminId: req.user.id, adminUsername: adminName, action, target, details, ip: req.ip });
        const fields = [{ name: 'Admin', value: adminName, inline: true }, { name: 'Target', value: target || 'N/A', inline: true }];
        if (details && Object.keys(details).length > 0) fields.push({ name: 'Details', value: JSON.stringify(details).substring(0, 1000) });
        let color = 0x3498db;
        if (['DELETE', 'RESET', 'REJECT', 'FORCE'].some(k => action.includes(k))) color = 0xe74c3c;
        if (['APPROVE', 'CREATE', 'UPDATE'].some(k => action.includes(k))) color = 0x2ecc71;
        await sendDiscordLog(req, `🛡️ Admin Action: ${action}`, `Action performed via Dashboard`, fields, color);
    } catch (e) { console.error("Log Error:", e); }
}

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
