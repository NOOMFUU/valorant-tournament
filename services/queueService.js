const agendaModule = require('agenda');
const Agenda = agendaModule.Agenda || agendaModule;
const Match = require('../models/Match');
const Team = require('../models/Team');
const BracketManager = require('../managers/bracketManager');
const discordService = require('./discordService');

const mongoConnectionString = process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney';

// Check-in window (ต้องตรงกับ routes/matchRoutes.js): เปิด 30 นาทีก่อนแข่ง, ปิด 15 นาทีหลังเวลาแข่ง
const CHECKIN_CLOSE_AFTER_MIN = 15;

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
            await channel.send({ content: `⏰ **1 HOUR REMAINING**\n${roleA} and ${roleB}, your match starts in 1 hour.`, allowedMentions: { parse: ['roles'] } });
        }
    } catch (e) {
        console.error(`Job match-reminder-1h failed for ${matchId}:`, e);
    }
});

// [NEW] Task: แจ้งเตือนก่อนแข่ง 5 นาที (Check-in Reminder)
agenda.define('match-reminder-5m', async (job) => {
    const { matchId } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled' || !match.discordChannelId) return;

        if (match.checkIn.teamA && match.checkIn.teamB) return;

        const channel = await discordService.client.channels.fetch(match.discordChannelId).catch(() => null);
        if (channel) {
            const roleA = match.teamA.discordRoleId ? `<@&${match.teamA.discordRoleId}>` : match.teamA.name;
            const roleB = match.teamB.discordRoleId ? `<@&${match.teamB.discordRoleId}>` : match.teamB.name;

            let msg = "";
            if (!match.checkIn.teamA && !match.checkIn.teamB) msg = `⚠️ **5 MINUTES REMAINING**\n${roleA} and ${roleB}, you have not checked in yet!`;
            else if (!match.checkIn.teamA) msg = `⚠️ **5 MINUTES REMAINING**\n${roleA}, please check in!`;
            else if (!match.checkIn.teamB) msg = `⚠️ **5 MINUTES REMAINING**\n${roleB}, please check in!`;

            if (msg) await channel.send({ content: msg, allowedMentions: { parse: ['roles'] } });
        }
    } catch (e) { console.error(`Job match-reminder-5m failed for ${matchId}:`, e); }
});

// [NEW] Task: Late Check-in Reminder (ทุก 3 นาทีหลังเวลาแข่ง)
agenda.define('match-reminder-late', async (job) => {
    const { matchId, minute } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled' || !match.discordChannelId) return;

        if (match.checkIn.teamA && match.checkIn.teamB) return;

        const channel = await discordService.client.channels.fetch(match.discordChannelId).catch(() => null);
        if (channel) {
            const roleA = match.teamA.discordRoleId ? `<@&${match.teamA.discordRoleId}>` : match.teamA.name;
            const roleB = match.teamB.discordRoleId ? `<@&${match.teamB.discordRoleId}>` : match.teamB.name;

            let msg = "";
            const remaining = CHECKIN_CLOSE_AFTER_MIN - minute;

            if (!match.checkIn.teamA && !match.checkIn.teamB) {
                msg = `⚠️ **LATE CHECK-IN (${minute}m passed)**\n${roleA} and ${roleB}, you are late! ${remaining} mins remaining before disqualification.`;
            } else if (!match.checkIn.teamA) {
                msg = `⚠️ **LATE CHECK-IN (${minute}m passed)**\n${roleA}, you are late! ${remaining} mins remaining before disqualification.`;
            } else if (!match.checkIn.teamB) {
                msg = `⚠️ **LATE CHECK-IN (${minute}m passed)**\n${roleB}, you are late! ${remaining} mins remaining before disqualification.`;
            }

            if (msg) await channel.send({ content: msg, allowedMentions: { parse: ['roles'] } });
        }
    } catch (e) { console.error(`Job match-reminder-late failed for ${matchId}:`, e); }
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

// 2. Task: ตรวจสอบการ Check-in เมื่อหมดเวลา check-in (เดิม: เวลาแข่ง + 15 นาทีฮาร์ดโค้ด)
// แก้ N2: เดิม match.winner.toString() จะพังเมื่อ winner เป็น null (กรณี Double Forfeit)
agenda.define('check-in-expiry', async (job) => {
    const { matchId } = job.attrs.data;
    try {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (!match || match.status !== 'scheduled') return;

        const aIn = !!match.checkIn.teamA;
        const bIn = !!match.checkIn.teamB;
        if (aIn && bIn) return; // ทั้งสองทีมมาแล้ว ไม่ต้องทำอะไร

        let winnerTeam = null;
        let loserTeam = null;
        let reason;
        let outcomeLabel;

        if (aIn && !bIn) {
            winnerTeam = match.teamA; loserTeam = match.teamB;
            reason = 'AUTO: Opponent Missed Check-in';
            outcomeLabel = 'A';
        } else if (!aIn && bIn) {
            winnerTeam = match.teamB; loserTeam = match.teamA;
            reason = 'AUTO: Opponent Missed Check-in';
            outcomeLabel = 'B';
        } else {
            reason = 'AUTO: Both Teams Missed Check-in';
            outcomeLabel = 'NONE';
        }

        match.status = 'finished';
        match.winner = winnerTeam ? winnerTeam._id : null;
        match.scoreSubmission.status = winnerTeam ? 'approved' : 'rejected';
        match.scoreSubmission.rejectReason = reason;
        match.name += winnerTeam ? " (Auto Win)" : " (Double Forfeit)";
        await match.save();

        if (winnerTeam && loserTeam) {
            const wTeam = await Team.findById(winnerTeam._id);
            const lTeam = await Team.findById(loserTeam._id);
            await BracketManager.propagateMatchResult(match, wTeam, lTeam);
            await Team.findByIdAndUpdate(winnerTeam._id, { $inc: { wins: 1 } });
            await Team.findByIdAndUpdate(loserTeam._id, { $inc: { losses: 1 } });
        }

        if (match.discordChannelId) {
            const channel = await discordService.client.channels.fetch(match.discordChannelId).catch(() => null);
            if (channel) {
                const roleA = match.teamA.discordRoleId ? `<@&${match.teamA.discordRoleId}>` : match.teamA.name;
                const roleB = match.teamB.discordRoleId ? `<@&${match.teamB.discordRoleId}>` : match.teamB.name;
                let msg = "";
                if (outcomeLabel === 'NONE') msg = `❌ **DOUBLE FORFEIT**\n${roleA} and ${roleB} failed to check-in. Match cancelled.`;
                else if (outcomeLabel === 'A') msg = `🏆 **AUTO WIN**\n${roleA} wins! ${roleB} failed to check-in.`;
                else msg = `🏆 **AUTO WIN**\n${roleB} wins! ${roleA} failed to check-in.`;
                await channel.send({ content: msg, allowedMentions: { parse: ['roles'] } });
            }
        }

        await discordService.sendMatchResultToDiscord(match);

        const io = require('../server').getIO();
        if (io) {
            io.emit('match_update', match);
            io.emit('bracket_update');
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
    const remind5mTime = new Date(matchTime.getTime() - 5 * 60000);
    const remind1hTime = new Date(matchTime.getTime() - 60 * 60000);
    const expiryTime = new Date(matchTime.getTime() + CHECKIN_CLOSE_AFTER_MIN * 60000);

    // ลบ Job เก่าของแมตช์นี้ก่อน (กรณี Reschedule)
    await agenda.cancel({ 'data.matchId': match._id });

    if (remind1hTime > new Date()) {
        await agenda.schedule(remind1hTime, 'match-reminder-1h', { matchId: match._id });
    }
    if (notifyTime > new Date()) {
        await agenda.schedule(notifyTime, 'match-notification', { matchId: match._id });
    }
    if (remind5mTime > new Date()) {
        await agenda.schedule(remind5mTime, 'match-reminder-5m', { matchId: match._id });
    }
    if (expiryTime > new Date()) {
        await agenda.schedule(expiryTime, 'check-in-expiry', { matchId: match._id });
    }

    // Late Reminders (3, 6, 9, 12 mins after start)
    for (let i = 3; i < CHECKIN_CLOSE_AFTER_MIN; i += 3) {
        const lateTime = new Date(matchTime.getTime() + i * 60000);
        if (lateTime > new Date()) {
            await agenda.schedule(lateTime, 'match-reminder-late', { matchId: match._id, minute: i });
        }
    }
};

module.exports = agenda;
