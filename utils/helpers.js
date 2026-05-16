const { EmbedBuilder } = require('discord.js');
const User = require('../models/User');
const AdminLog = require('../models/AdminLog');
const Notification = require('../models/Notification');

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

async function createNotification(req, message, type = 'info', options = {}) {
    try {
        const { recipientId, recipientModel, globalRole, title, link } = options;
        const n = await Notification.create({
            message,
            type,
            recipientId,
            recipientModel,
            globalRole,
            title,
            link
        });
        
        // Emit via socket if available
        const io = req.app.get('io');
        if (io) {
            if (globalRole === 'all') io.emit('notification', { msg: message, type });
            else if (recipientId && recipientModel === 'Team') io.to(recipientId.toString()).emit('notification', { msg: message, type });
            else io.emit('notification', { msg: message, type }); // Fallback broadcast
        }
        return n;
    } catch (e) { console.error("Failed to create notification:", e); }
}

module.exports = { sendDiscordLog, logAdminAction, createNotification };
