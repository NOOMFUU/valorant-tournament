const AgendaNpm = require('agenda');
const Agenda = AgendaNpm.Agenda || AgendaNpm;
const Match = require('../models/Match');
const Team = require('../models/Team');
const BracketManager = require('../managers/bracketManager');
const discordService = require('./discordService');

const mongoConnectionString = process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney';

const agenda = new Agenda({ 
    db: { address: mongoConnectionString, collection: 'agendaJobs' },
    processEvery: '30 seconds'
});

// [NEW] Task: แจ้งเตือนก่อนแข่ง 1 ชั่วโมง
agenda.define('match-reminder-1h', async (job) => {
    const { matchId } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled' || !match.discordChannelId) return;

        const channel = await discordService.client.channels.fetch(match.discordChannelId).catch(() => null);
        if (channel) {
            const roleA = match.teamA.discordRoleId ? `<@&${match.teamA.discordRoleId}>` : match.teamA.name;
            const roleB = match.teamB.discordRoleId ? `<@&${match.teamB.discordRoleId}>` : match.teamB.name;
            await channel.send(`⏰ **1 HOUR REMAINING**\n${roleA} and ${roleB}, your match starts in 1 hour.`);
        }
    } catch (e) {
        console.error(`Job match-reminder-1h failed for ${matchId}:`, e);
    }
});

// 1. Task: แจ้งเตือนก่อนแข่ง 10 นาที
agenda.define('match-notification', async (job) => {
    const { matchId } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled' || !match.discordChannelId) return;

        const channel = await discordService.client.channels.fetch(match.discordChannelId).catch(() => null);
        if (channel) {
            const roleA = match.teamA.discordRoleId ? `<@&${match.teamA.discordRoleId}>` : match.teamA.name;
            const roleB = match.teamB.discordRoleId ? `<@&${match.teamB.discordRoleId}>` : match.teamB.name;
            
            // [NEW] Add Check-in Button
            const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`checkin_${matchId}`)
                        .setLabel('✅ Check-in Now')
                        .setStyle(ButtonStyle.Success)
                );

            await channel.send({ content: `🚨 **10 MINUTES REMAINING** 🚨\n${roleA} and ${roleB}, please prepare for your match! Check-in is open.`, components: [row] });
            match.notificationSent = true;
            await match.save();
        }
    } catch (e) {
        console.error(`Job match-notification failed for ${matchId}:`, e);
    }
});

// 2. Task: ตรวจสอบการ Check-in เมื่อถึงเวลาแข่ง
agenda.define('check-in-expiry', async (job) => {
    const { matchId } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled') return;

        let changed = false;
        // Team A มา, Team B หาย -> A ชนะ
        if (match.checkIn.teamA && !match.checkIn.teamB) {
            match.status = 'finished';
            match.winner = match.teamA;
            match.scoreSubmission.status = 'approved';
            match.scoreSubmission.rejectReason = 'AUTO: Opponent Missed Check-in';
            match.name += " (Auto Win)";
            changed = true;
        }
        // Team B มา, Team A หาย -> B ชนะ
        else if (!match.checkIn.teamA && match.checkIn.teamB) {
            match.status = 'finished';
            match.winner = match.teamB;
            match.scoreSubmission.status = 'approved';
            match.scoreSubmission.rejectReason = 'AUTO: Opponent Missed Check-in';
            match.name += " (Auto Win)";
            changed = true;
        }

        if (changed) {
            await match.save();

            // [NEW] Send Result to Discord
            await discordService.sendMatchResultToDiscord(match);
            
            // อัปเดต Bracket และ Stats
            const winnerId = match.winner.toString();
            const loserId = (winnerId === match.teamA?.toString()) ? match.teamB : match.teamA;
            const wTeam = await Team.findById(winnerId);
            const lTeam = loserId ? await Team.findById(loserId) : null;

            await BracketManager.propagateMatchResult(match, wTeam, lTeam);
            await Team.findByIdAndUpdate(winnerId, { $inc: { wins: 1 } });
            if (lTeam) await Team.findByIdAndUpdate(lTeam._id, { $inc: { losses: 1 } });

            // แจ้ง Socket.io (ต้องดึง io จาก app หรือส่งเข้ามา)
            const io = require('../server').getIO(); 
            if (io) {
                io.emit('match_update', match);
                io.emit('bracket_update');
            }
        }
    } catch (e) {
        console.error(`Job check-in-expiry failed for ${matchId}:`, e);
    }
});

// Helper: Schedule Jobs for a Match
agenda.scheduleMatchJobs = async (match) => {
    if (!match.scheduledTime) return;
    
    const matchTime = new Date(match.scheduledTime);
    const notifyTime = new Date(matchTime.getTime() - 10 * 60000);
    const remind1hTime = new Date(matchTime.getTime() - 60 * 60000); // 1 hour
    const forfeitTime = new Date(matchTime.getTime() + 15 * 60000); // [NEW] 15 mins grace period

    // ลบ Job เก่าของแมตช์นี้ก่อน (กรณี Reschedule)
    await agenda.cancel({ 'data.matchId': match._id });

    // ตั้งเวลาใหม่
    if (remind1hTime > new Date()) {
        await agenda.schedule(remind1hTime, 'match-reminder-1h', { matchId: match._id });
    }
    if (notifyTime > new Date()) {
        await agenda.schedule(notifyTime, 'match-notification', { matchId: match._id });
    }
    if (forfeitTime > new Date()) {
        await agenda.schedule(forfeitTime, 'check-in-expiry', { matchId: match._id });
    }
};

module.exports = agenda;
