const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { EmbedBuilder } = require('discord.js');

let imgbbUploader;
try { imgbbUploader = require('imgbb-uploader'); } catch (e) {}

// Import Models
const Match = require('../models/Match');
const Team = require('../models/Team');
const Tournament = require('../models/Tournament');

// Import Managers
const BracketManager = require('../managers/bracketManager');
const queueService = require('../services/queueService');

// --- HELPERS & MIDDLEWARE ---
const auth = require('../middleware/auth');
const { upload, getFileUrl } = require('../middleware/upload');
const { logAdminAction } = require('../utils/helpers');

// --- ROUTES ---

// GET All Matches
router.get('/matches', async (req, res) => {
    try {
        const matches = await Match.find()
            .populate({ path: 'teamA', populate: { path: 'members' } })
            .populate({ path: 'teamB', populate: { path: 'members' } })
            .populate('winner')
            .populate('tournament');

        const vetoMgr = req.app.get('vetoMgr');
        const matchesWithPresence = matches.map(m => {
            const obj = m.toObject();
            obj.presence = (vetoMgr && vetoMgr.presence[m._id.toString()]) || {};
            return obj;
        });
        res.json(matchesWithPresence);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// GET Upcoming Matches (Team)
router.get('/matches/upcoming', auth(['team']), async (req, res) => {
    try {
        const teamId = req.user.id;
        const matches = await Match.find({
            $or: [{ teamA: teamId }, { teamB: teamId }],
            status: { $in: ['scheduled', 'live', 'pending_approval'] }
        }).populate('teamA teamB tournament').sort({ scheduledTime: 1 });
        res.json(matches);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// GET Match History (Team)
router.get('/matches/history', auth(['team']), async (req, res) => {
    try {
        const teamId = req.user.id;
        const matches = await Match.find({
            $or: [{ teamA: teamId }, { teamB: teamId }],
            status: 'finished'
        }).populate('teamA teamB tournament').sort({ updatedAt: -1 });
        res.json(matches);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// GET Single Match
router.get('/matches/:id', async (req, res) => {
    try {
        const match = await Match.findById(req.params.id)
            .populate({ path: 'teamA', populate: { path: 'members' } })
            .populate({ path: 'teamB', populate: { path: 'members' } });
        res.json(match);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// DELETE Match
router.delete('/matches/:id', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (match) {
            const deleteMatchChannels = req.app.get('deleteMatchChannels');
            if (deleteMatchChannels) await deleteMatchChannels(match);
            
            await Match.findByIdAndDelete(req.params.id);
            await Tournament.updateMany({ "stages.matches": req.params.id }, { $pull: { "stages.$[].matches": req.params.id } });
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// UPDATE Match Info
router.put('/matches/:id', auth(['admin']), async (req, res) => {
    try {
        const { format, name, status, scheduledTime } = req.body;
        const update = {};
        if (format) update.format = format;
        if (name) update.name = name;
        if (status) update.status = status;
        if (scheduledTime !== undefined) update.scheduledTime = scheduledTime;

        const match = await Match.findByIdAndUpdate(req.params.id, update, { new: true });
        req.app.get('io').emit('match_update', match);

        if (scheduledTime !== undefined) {
            const msg = `Match ${match.name} time updated: ${new Date(scheduledTime).toLocaleString()}`;
            if (match.teamA) req.app.get('io').to(match.teamA.toString()).emit('notification', { msg });
            if (match.teamB) req.app.get('io').to(match.teamB.toString()).emit('notification', { msg });
            await queueService.scheduleMatchJobs(match); // [NEW] Schedule Agenda Jobs
            
            const updateMatchTime = req.app.get('updateMatchTime');
            if (updateMatchTime) updateMatchTime(match);
        }

        if (match.teamA && match.teamB) {
            const createMatchChannel = req.app.get('createMatchChannel');
            if (createMatchChannel) createMatchChannel(match);
        }

        res.json({ success: true, match });
    } catch (e) { res.status(500).json(e); }
});

// SWAP Teams
router.post('/matches/swap-teams', auth(['admin']), async (req, res) => {
    try {
        const { match1Id, slot1, match2Id, slot2 } = req.body;
        let m1 = await Match.findById(match1Id);
        let m2 = (match1Id === match2Id) ? m1 : await Match.findById(match2Id);

        if (!m1 || !m2) return res.status(404).json({ msg: 'Match not found' });
        if (m1.status === 'finished' || m2.status === 'finished') return res.status(400).json({ msg: 'Cannot swap finished matches' });

        const team1Id = m1[slot1];
        const team2Id = m2[slot2];

        m1[slot1] = team2Id;
        m2[slot2] = team1Id;

        const getRoster = async (tid) => { if (!tid) return []; const t = await Team.findById(tid); return t ? t.members : []; };
        m1[`${slot1}Roster`] = await getRoster(team2Id);
        m2[`${slot2}Roster`] = await getRoster(team1Id);

        await m1.save();
        if (m1._id.toString() !== m2._id.toString()) await m2.save();

        await logAdminAction(req, 'SWAP_TEAMS', `Swapped ${slot1} of Match ${m1.matchNumber} with ${slot2} of Match ${m2.matchNumber}`, {});
        req.app.get('io').emit('match_update', m1);
        if (m1._id.toString() !== m2._id.toString()) req.app.get('io').emit('match_update', m2);
        req.app.get('io').emit('bracket_update');

        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// FORCE Winner
router.post('/matches/:id/force-winner', auth(['admin']), async (req, res) => {
    try {
        const { winnerId } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        const winner = match.teamA._id.toString() === winnerId ? match.teamA : match.teamB;
        const loser = match.teamA._id.toString() === winnerId ? match.teamB : match.teamA;

        match.winner = winner;
        match.status = 'finished';
        match.scoreSubmission.status = 'approved';
        match.scoreSubmission.rejectReason = 'Admin Override';

        await match.save();
        await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
        await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });

        await BracketManager.propagateMatchResult(match, winner, loser);
        await logAdminAction(req, 'FORCE_WINNER', `Match ${match.matchNumber} (${match.name})`, { winner: winner.name });

        const sendMatchResultToDiscord = req.app.get('sendMatchResultToDiscord');
        const deleteMatchVoiceChannels = req.app.get('deleteMatchVoiceChannels');
        if (sendMatchResultToDiscord) sendMatchResultToDiscord(match);
        if (deleteMatchVoiceChannels) await deleteMatchVoiceChannels(match);

        req.app.get('io').emit('match_update', match);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, msg: `Forced win for ${winner.name}` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// SUBMIT Score
router.post('/matches/:id/submit-score', auth(['team']), upload.any(), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        let scores = JSON.parse(req.body.scores);
        req.files.forEach(file => {
            const parts = file.fieldname.split('_');
            if (parts.length === 2 && parts[0] === 'proof') {
                const index = parseInt(parts[1]);
                if (scores[index]) scores[index].proofImage = getFileUrl(file);
            }
        });

        match.scoreSubmission = { submittedBy: req.user.id, tempScores: scores, status: 'pending' };
        match.status = 'pending_approval';
        await match.save();
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// CLAIM Forfeit
router.post('/matches/:id/claim-forfeit', auth(['team']), upload.single('proof'), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.status === 'finished') return res.status(400).json({ msg: 'Match already finished' });

        if (!match.scheduledTime) return res.status(400).json({ msg: 'Match has no scheduled time' });
        const diffMinutes = (new Date() - new Date(match.scheduledTime)) / 1000 / 60;

        if (diffMinutes < 15) return res.status(400).json({ msg: `Wait at least 15 minutes after schedule time` });
        if (!req.file) return res.status(400).json({ msg: 'Proof screenshot is required' });

        const isTeamA = match.teamA._id.toString() === req.user.id;
        const mapCount = match.format === 'BO1' ? 1 : (match.format === 'BO3' ? 2 : 3);
        const forfeitScores = [];

        for (let i = 0; i < mapCount; i++) {
            forfeitScores.push({
                mapName: `Forfeit Map ${i + 1}`,
                teamAScore: isTeamA ? 13 : 0,
                teamBScore: isTeamA ? 0 : 13,
                proofImage: getFileUrl(req.file)
            });
        }

        match.scoreSubmission = { submittedBy: req.user.id, tempScores: forfeitScores, status: 'pending', rejectReason: 'FORFEIT CLAIM' };
        match.status = 'pending_approval';
        await match.save();
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// EDIT Submission (Admin)
router.put('/matches/:id/submission/edit', auth(['admin']), async (req, res) => {
    try {
        const { mapIndex, teamAScore, teamBScore } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match || match.status !== 'pending_approval') return res.status(400).json({ msg: 'Match is not in a pending approval state.' });

        if (match.scoreSubmission.tempScores[mapIndex]) {
            match.scoreSubmission.tempScores[mapIndex].teamAScore = teamAScore;
            match.scoreSubmission.tempScores[mapIndex].teamBScore = teamBScore;
            match.markModified('scoreSubmission.tempScores');
            await match.save();
            await logAdminAction(req, 'EDIT_PENDING_SCORE', `Match ${match.matchNumber}`, { mapIndex, teamAScore, teamBScore });
            req.app.get('io').emit('match_update', match);
            res.json({ success: true, match });
        } else res.status(404).json({ msg: 'Map index not found.' });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// APPROVE Score
router.post('/matches/:id/approve-score', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB nextMatchId loserMatchId');
        if (!match) return res.status(404).json({ msg: 'Not found' });

        match.scores = match.scoreSubmission.tempScores;
        let wA = 0, wB = 0;
        match.scores.forEach(s => {
            if (parseInt(s.teamAScore) > parseInt(s.teamBScore)) wA++;
            else if (parseInt(s.teamBScore) > parseInt(s.teamAScore)) wB++;
        });

        const winner = wA > wB ? match.teamA : match.teamB;
        const loser = wA > wB ? match.teamB : match.teamA;

        match.winner = winner;
        match.status = 'finished';
        if (match.scoreSubmission.rejectReason === 'FORFEIT CLAIM') match.name += " (Forfeit)";
        match.scoreSubmission.status = 'approved';
        await match.save();

        await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
        await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });

        await BracketManager.propagateMatchResult(match, winner, loser);
        await logAdminAction(req, 'APPROVE_SCORE', `Match ${match.matchNumber} (${match.name})`, { winner: winner.name });

        const sendMatchResultToDiscord = req.app.get('sendMatchResultToDiscord');
        const deleteMatchVoiceChannels = req.app.get('deleteMatchVoiceChannels');
        if (sendMatchResultToDiscord) sendMatchResultToDiscord(match);
        if (deleteMatchVoiceChannels) await deleteMatchVoiceChannels(match);

        req.app.get('io').emit('match_update', match);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// REJECT Score
router.post('/matches/:id/reject-score', auth(['admin']), async (req, res) => {
    try {
        const { reason } = req.body;
        const match = await Match.findById(req.params.id);
        match.status = 'live';
        match.scoreSubmission.status = 'rejected';
        match.scoreSubmission.rejectReason = reason || 'Rejected';
        match.scoreSubmission.tempScores = [];
        await match.save();
        await logAdminAction(req, 'REJECT_SCORE', `Match ${match.matchNumber} (${match.name})`, { reason });
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: 'Server error' }); }
});

// MANUAL Score
router.put('/matches/:id/manual-score', auth(['admin']), async (req, res) => {
    try {
        const { scores } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        match.scores = scores;
        let wA = 0, wB = 0;
        scores.forEach(s => {
            const sA = parseInt(s.teamAScore) || 0;
            const sB = parseInt(s.teamBScore) || 0;
            if (sA > sB) wA++; else if (sB > sA) wB++;
        });

        const mapsNeeded = match.format === 'BO1' ? 1 : (match.format === 'BO3' ? 2 : 3);
        const wasFinished = match.status === 'finished';

        if (wA >= mapsNeeded || wB >= mapsNeeded) {
            const winner = wA > wB ? match.teamA : match.teamB;
            const loser = wA > wB ? match.teamB : match.teamA;
            if (winner && loser) {
                match.winner = winner;
                match.status = 'finished';
                match.scoreSubmission.status = 'approved';
                match.scoreSubmission.rejectReason = 'Admin Manual Entry';
                if (!wasFinished) {
                    await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
                    await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });
                }
                await BracketManager.propagateMatchResult(match, winner, loser);
                req.app.get('io').emit('bracket_update');
                
                const sendMatchResultToDiscord = req.app.get('sendMatchResultToDiscord');
                const deleteMatchVoiceChannels = req.app.get('deleteMatchVoiceChannels');
                if (sendMatchResultToDiscord) sendMatchResultToDiscord(match);
                if (deleteMatchVoiceChannels) await deleteMatchVoiceChannels(match);
            }
        }
        await match.save();
        await logAdminAction(req, 'MANUAL_SCORE', `Match ${match.matchNumber} (${match.name})`, { scores });
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESET Veto
router.post('/matches/:id/reset-veto', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        match.vetoData = { status: 'pending', mapPool: [], bannedMaps: [], pickedMaps: [], history: [], sequence: [], sequenceIndex: 0, teamAReady: false, teamBReady: false };
        match.status = 'scheduled';
        match.roomPassword = "";
        match.scores = [];
        match.winner = null;
        await match.save();
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json(e); }
});

// RESET Match
router.post('/matches/:id/reset', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        match.status = 'scheduled';
        match.winner = null;
        match.scores = [];
        match.roomPassword = "";
        match.scoreSubmission = { status: 'none', tempScores: [] };
        match.checkIn = { teamA: false, teamB: false, windowOpen: false };
        match.vetoData = { status: 'pending', mapPool: [], bannedMaps: [], pickedMaps: [], history: [], sequence: [], sequenceIndex: 0, teamAReady: false, teamBReady: false };
        await match.save();
        await logAdminAction(req, 'RESET_MATCH', `Match ${match.matchNumber} (${match.name})`, {});
        req.app.get('io').emit('match_update', match);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, msg: 'Match has been reset for rematch.' });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// CHECK-IN
router.post('/matches/:id/checkin', auth(['team']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (!match.scheduledTime) return res.status(400).json({ msg: 'Match has no scheduled time' });

        const now = new Date();
        const matchTime = new Date(match.scheduledTime);
        const diffMinutes = (matchTime - now) / 1000 / 60;

        if (diffMinutes > 30 && !match.checkIn.windowOpen) return res.status(400).json({ msg: 'Check-in not open yet (Opens 30m before)' });
        if (diffMinutes < -10 && !match.checkIn.windowOpen) return res.status(400).json({ msg: 'Check-in closed' });

        const teamId = req.user.id;
        let checked = false;
        if (match.teamA && match.teamA.toString() === teamId) { match.checkIn.teamA = true; checked = true; }
        else if (match.teamB && match.teamB.toString() === teamId) { match.checkIn.teamB = true; checked = true; }

        if (checked) {
            await match.save();
            req.app.get('io').emit('match_update', match);
            res.json({ success: true, msg: 'Check-in Successful' });
        } else res.status(403).json({ msg: 'You are not in this match' });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESCHEDULE Request
router.post('/matches/:id/reschedule', auth(['team']), async (req, res) => {
    try {
        const { proposedTime, reason } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.teamA._id.toString() !== req.user.id && match.teamB._id.toString() !== req.user.id) return res.status(403).json({ msg: 'Unauthorized' });
        if (match.status !== 'scheduled') return res.status(400).json({ msg: 'Match not scheduled' });

        match.rescheduleRequest = { requestedBy: req.user.id, proposedTime: new Date(proposedTime), reason: reason || 'No reason provided', status: 'pending' };
        await match.save();
        req.app.get('io').emit('match_update', match);

        const opponentId = match.teamA._id.toString() === req.user.id ? match.teamB._id.toString() : match.teamA._id.toString();
        req.app.get('io').to(opponentId).emit('notification', { msg: `Reschedule Request received for ${match.name}` });

        if (match.discordChannelId) {
            const discordClient = req.app.get('discordClient');
            const channel = await discordClient.channels.fetch(match.discordChannelId).catch(() => null);
            if (channel) {
                const requesterTeam = match.teamA._id.toString() === req.user.id ? match.teamA : match.teamB;
                const opponentTeam = match.teamA._id.toString() === req.user.id ? match.teamB : match.teamA;
                const opponentRole = opponentTeam.discordRoleId ? `<@&${opponentTeam.discordRoleId}>` : opponentTeam.name;
                const timeString = `<t:${Math.floor(new Date(proposedTime).getTime() / 1000)}:F>`;
                const embed = new EmbedBuilder().setColor(0xffaa00).setTitle('📅 Reschedule Requested').setDescription(`**${requesterTeam.name}** has requested to reschedule this match.`).addFields({ name: 'Proposed Time', value: timeString, inline: true }, { name: 'Reason', value: reason || 'No reason provided', inline: true }).setFooter({ text: 'Please accept or reject in the dashboard.' }).setTimestamp();
                await channel.send({ content: `${opponentRole}`, embeds: [embed] });
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESCHEDULE Response
router.post('/matches/:id/reschedule/respond', auth(['team']), async (req, res) => {
    try {
        const { action } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.rescheduleRequest.status !== 'pending') return res.status(400).json({ msg: 'No pending request' });
        if (match.rescheduleRequest.requestedBy.toString() === req.user.id) return res.status(400).json({ msg: 'Cannot respond to own request' });

        const requester = match.rescheduleRequest.requestedBy;
        const responderId = req.user.id;
        const requesterTeam = match.teamA._id.toString() === requester.toString() ? match.teamA : match.teamB;
        const responderTeam = match.teamA._id.toString() === responderId ? match.teamA : match.teamB;
        const oldTime = match.rescheduleRequest.proposedTime;

        if (action === 'accept') {
            match.scheduledTime = match.rescheduleRequest.proposedTime;
            match.checkIn = { teamA: false, teamB: false, windowOpen: false };
            await queueService.scheduleMatchJobs(match); // [NEW] Update Schedule
            
            const updateMatchTime = req.app.get('updateMatchTime');
            if (updateMatchTime) updateMatchTime(match);
        }
        match.rescheduleRequest = { status: 'none' };
        await match.save();
        req.app.get('io').emit('match_update', match);

        if (requester) {
            const msg = action === 'accept' ? `Reschedule ACCEPTED for ${match.name}` : `Reschedule REJECTED for ${match.name}`;
            req.app.get('io').to(requester.toString()).emit('notification', { msg });
        }

        if (match.discordChannelId) {
            const discordClient = req.app.get('discordClient');
            const channel = await discordClient.channels.fetch(match.discordChannelId).catch(() => null);
            if (channel) {
                const requesterRole = requesterTeam.discordRoleId ? `<@&${requesterTeam.discordRoleId}>` : requesterTeam.name;
                const isAccepted = action === 'accept';
                const embed = new EmbedBuilder().setColor(isAccepted ? 0x2ecc71 : 0xe74c3c).setTitle(isAccepted ? '✅ Reschedule Accepted' : '❌ Reschedule Rejected').setDescription(isAccepted ? `**${responderTeam.name}** accepted the reschedule.\n**New Time:** <t:${Math.floor(new Date(oldTime).getTime() / 1000)}:F>` : `**${responderTeam.name}** rejected the reschedule request.`).setTimestamp();
                await channel.send({ content: `${requesterRole}`, embeds: [embed] });
            }
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// PAUSE Request
router.post('/matches/:id/pause', auth(['team']), async (req, res) => {
    try {
        const { reason } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.teamA.toString() !== req.user.id && match.teamB.toString() !== req.user.id) return res.status(403).json({ msg: 'Unauthorized' });

        const isVetoLive = match.status === 'scheduled' && match.vetoData && match.vetoData.status === 'in_progress';
        if (match.status !== 'live' && !isVetoLive) return res.status(400).json({ msg: 'Match is not live or in veto' });

        const vetoMgr = req.app.get('vetoMgr');
        if (isVetoLive && vetoMgr) {
            const result = await vetoMgr.handleTeamPause(req.params.id, req.user.id);
            if (!result.success) return res.status(400).json({ msg: result.msg });
            return res.json({ success: true });
        }

        match.pauseRequest = { requestedBy: req.user.id, reason: reason || 'Technical Issue', status: 'pending', timestamp: new Date() };
        await match.save();
        req.app.get('io').emit('match_update', match);
        req.app.get('io').emit('notification', { msg: `⚠️ PAUSE REQUESTED: ${match.name}`, type: 'error' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESUME Match
router.post('/matches/:id/resume', auth(['team']), async (req, res) => {
    try {
        const vetoMgr = req.app.get('vetoMgr');
        if (vetoMgr) {
            const result = await vetoMgr.handleTeamResume(req.params.id, req.user.id);
            if (!result.success) return res.status(400).json({ msg: result.msg });
            res.json({ success: true });
        } else res.status(500).json({ msg: 'Veto Manager not available' });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ADMIN PAUSE Veto
router.post('/matches/:id/admin-pause', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        const vetoMgr = req.app.get('vetoMgr');
        if (match.vetoData && match.vetoData.status === 'in_progress' && vetoMgr) {
            await vetoMgr.adminPause(match);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESOLVE Pause
router.post('/matches/:id/pause/resolve', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        match.pauseRequest.status = 'resolved';
        const vetoMgr = req.app.get('vetoMgr');

        if (match.status === 'scheduled' && match.vetoData && match.vetoData.status === 'paused' && vetoMgr) {
            match.vetoData.status = 'in_progress';
            match.vetoData.pausedBy = null;
            await vetoMgr.logAction(match, "RESUME: Admin resolved pause");
            await match.save();
            await vetoMgr.resumeTimer(match);
        } else {
            await match.save();
        }
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// RESET Veto Timer
router.post('/matches/:id/reset-timer', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        const vetoMgr = req.app.get('vetoMgr');
        if (vetoMgr) await vetoMgr.resetTurnTimer(match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;