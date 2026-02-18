const express = require('express');
const router = express.Router();
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Import Models
const Team = require('../models/Team');
const AdminLog = require('../models/AdminLog');
const User = require('../models/User');

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

const csvUpload = multer({ storage: multer.memoryStorage() });

// --- ROUTES ---

// Import Discord IDs from CSV
router.post('/admin/discord/import', auth(['admin']), csvUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });
        const lines = req.file.buffer.toString('utf8').split(/\r?\n/);
        let updated = 0, errors = 0;
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const [teamName, playerName, discordId] = line.split(',').map(s => s.trim());
            if (teamName && playerName && discordId) {
                const team = await Team.findOne({ name: new RegExp(`^${teamName}$`, 'i') });
                if (team) {
                    const member = team.members.find(m => m.name.toLowerCase() === playerName.toLowerCase());
                    if (member) { member.discordId = discordId; await team.save(); updated++; } else errors++;
                } else errors++;
            }
        }
        await logAdminAction(req, 'IMPORT_DISCORD', 'CSV Import', { updated, errors });
        res.json({ success: true, msg: `Updated ${updated} players. ${errors} failed.` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Sync All Roles
router.post('/admin/discord/sync-all-roles', auth(['admin']), async (req, res) => {
    try {
        const guildId = process.env.DISCORD_GUILD_ID;
        const discordClient = req.app.get('discordClient');
        if (!guildId || !discordClient) return res.status(500).json({ msg: 'Discord not configured' });
        const guild = await discordClient.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.status(500).json({ msg: 'Guild not found' });

        const teams = await Team.find({ status: 'approved' });
        let rolesCreated = 0, membersUpdated = 0;

        for (const team of teams) {
            let role;
            if (team.discordRoleId) role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
            if (!role) {
                const existing = guild.roles.cache.find(r => r.name === team.name);
                if (existing) role = existing;
                else {
                    try { role = await guild.roles.create({ name: team.name, color: '#ff4655', reason: 'Bulk Sync' }); rolesCreated++; } 
                    catch (e) { continue; }
                }
                team.discordRoleId = role.id; await team.save();
            }
            if (role) {
                for (const m of team.members) {
                    if (m.discordId) {
                        try {
                            const member = await guild.members.fetch(m.discordId).catch(() => null);
                            if (member && !member.roles.cache.has(role.id)) { await member.roles.add(role); membersUpdated++; }
                        } catch (e) {}
                    }
                }
            }
        }
        await logAdminAction(req, 'SYNC_ALL_ROLES', 'Discord', { rolesCreated, membersUpdated });
        res.json({ success: true, msg: `Sync Complete: ${rolesCreated} roles, ${membersUpdated} members.` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Sync Single Team Role
router.post('/teams/:id/discord/sync-role', auth(['admin']), async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);
        if (!team) return res.status(404).json({ msg: 'Team not found' });
        const guildId = process.env.DISCORD_GUILD_ID;
        const discordClient = req.app.get('discordClient');
        if (!guildId || !discordClient) return res.status(500).json({ msg: 'Discord not configured' });
        const guild = await discordClient.guilds.fetch(guildId).catch(() => null);
        
        let role;
        if (team.discordRoleId) role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
        if (!role) {
            role = await guild.roles.create({ name: team.name, color: '#ff4655', reason: `Role for ${team.name}` });
            team.discordRoleId = role.id; await team.save();
        } else if (role.name !== team.name) {
            await role.edit({ name: team.name }).catch(() => {});
        }
        res.json({ success: true, roleId: role.id, roleName: role.name });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Send Claim Button
router.post('/admin/discord/send-claim', auth(['admin']), async (req, res) => {
    try {
        const discordClient = req.app.get('discordClient');
        const channelId = process.env.DISCORD_CLAIM_CHANNEL_ID;
        if (!channelId || !discordClient) return res.status(400).json({ msg: 'Channel ID not configured' });

        const channel = await discordClient.channels.fetch(channelId).catch(() => null);
        if (!channel) return res.status(404).json({ msg: 'Channel not found' });

        const embed = new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('🛡️ TOURNAMENT ROLE CLAIM')
            .setDescription('Click the button below to verify your registration and claim your Team Role.\nEnsure your Discord ID matches the one provided to the admins.')
            .setFooter({ text: 'VCT System' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('claim_role')
                    .setLabel('Claim Team Role')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔐')
            );

        await channel.send({ embeds: [embed], components: [row] });
        await logAdminAction(req, 'SEND_DISCORD_CLAIM', 'Discord Channel', {});
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;
