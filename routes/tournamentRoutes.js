const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

// Import Models
const Tournament = require('../models/Tournament');
const Match = require('../models/Match');
const Team = require('../models/Team');

// Import Managers
const BracketManager = require('../managers/bracketManager');

// --- MIDDLEWARE ---
const auth = require('../middleware/auth');

// --- ROUTES ---

// GET All Tournaments
router.get('/tournaments', async (req, res) => {
    const t = await Tournament.find().populate('participants').sort({ createdAt: -1 });
    res.json(t);
});

// GET Public Tournament Data
router.get('/tournaments/:id/public', async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id)
            .select('-stages.matches.roomPassword -stages.matches.chat')
            .populate({
                path: 'participants',
                select: 'name shortName logo wins losses'
            })
            .populate({
                path: 'stages.matches',
                populate: {
                    path: 'teamA teamB winner',
                    select: 'name shortName logo'
                },
                select: '-roomPassword -chat -vetoData.history'
            });

        if (!tournament) return res.status(404).json({ msg: 'Tournament not found' });
        res.json(tournament);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// CREATE Tournament
router.post('/tournaments', auth(['admin']), async (req, res) => {
    const { name, teamIds, mapPool } = req.body;

    // [NEW] Clean up existing channels before wiping
    const matches = await Match.find({});
    const deleteMatchChannels = req.app.get('deleteMatchChannels');
    if (deleteMatchChannels) {
        for (const m of matches) await deleteMatchChannels(m);
    }

    // Note: Logic in server.js cleared all tournaments/matches. Keeping it consistent.
    await Tournament.deleteMany({});
    await Match.deleteMany({});

    const tournament = new Tournament({
        name,
        participants: teamIds,
        mapPool: mapPool,
        status: 'active'
    });

    await tournament.save();
    res.json({ success: true, id: tournament._id });
});

// UPDATE Tournament
router.put('/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const { name, mapPool, prizePool, formatDescription } = req.body;
        const update = { name, mapPool };
        if (prizePool !== undefined) update.prizePool = prizePool;
        if (formatDescription !== undefined) update.formatDescription = formatDescription;
        await Tournament.findByIdAndUpdate(req.params.id, update);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// GENERATE STAGE
router.post('/tournaments/:id/stages/generate', auth(['admin']), async (req, res) => {
    try {
        const { name, type, participants, settings } = req.body;
        const tournament = await Tournament.findById(req.params.id).populate({
            path: 'stages.matches',
            populate: { path: 'teamA teamB winner' }
        });

        let finalParticipants = [];

        // 1. STAGE-TO-STAGE LOGIC
        if (settings.sourceStageIndex >= 0 && tournament.stages[settings.sourceStageIndex] && !settings.usePlaceholders) {
            const sourceStage = tournament.stages[settings.sourceStageIndex];
            const sourceMatches = sourceStage.matches;

            if (sourceStage.type === 'gsl' && settings.advanceMethod === 'cross_group') {
                const groupWinners = [];
                const groupRunnersUp = [];

                sourceMatches.forEach(m => {
                    if (m.status === 'finished' && m.winner) {
                        if (m.name.includes('Winners')) groupWinners.push({ team: m.winner, match: m });
                        if (m.name.includes('Decider')) groupRunnersUp.push({ team: m.winner, match: m });
                    }
                });

                const getGroupChar = (n) => n.split('Group ')[1]?.[0] || 'Z';
                groupWinners.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));
                groupRunnersUp.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));

                finalParticipants = [
                    ...groupWinners.map(x => x.team),
                    ...groupRunnersUp.map(x => x.team)
                ];

                const teamsDb = await Team.find({ _id: { $in: finalParticipants } });
                finalParticipants = finalParticipants.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);

            }
            else if (['round_robin', 'swiss'].includes(sourceStage.type)) {
                const standings = await BracketManager.getStageStandings(tournament._id, settings.sourceStageIndex);

                const grouped = {};
                standings.forEach(s => {
                    const g = s.group || 'A';
                    if (!grouped[g]) grouped[g] = [];
                    grouped[g].push(s);
                });

                const count = settings.advanceCount || 2;
                const selectedIds = [];

                Object.keys(grouped).sort().forEach(g => {
                    const top = grouped[g].slice(0, count);
                    selectedIds.push(...top.map(s => s.id));
                });

                const teamsDb = await Team.find({ _id: { $in: selectedIds } });
                finalParticipants = selectedIds.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);
            }
            else {
                const teamsDb = await Team.find({ _id: { $in: participants || [] } });
                finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
            }

        } else {
            const teamsDb = await Team.find({ _id: { $in: participants } });
            finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
        }

        // [NEW] If using placeholders, we might pass empty participants but BracketManager handles it
        if (settings.usePlaceholders) {
            finalParticipants = []; // BracketManager will generate seeds
        }

        if (type === 'triple_elim' && settings.teamCount) {
            const teamCount = parseInt(settings.teamCount, 10);
            if (!Number.isNaN(teamCount) && teamCount > 0 && finalParticipants.length >= teamCount) {
                finalParticipants = finalParticipants.slice(0, teamCount);
            }
        }

        const matchesIds = await BracketManager.generateStage(tournament._id, name, type, finalParticipants, settings);

        tournament.stages.push({
            name, type, settings,
            stageParticipants: finalParticipants.map(t => t._id),
            matches: matchesIds
        });

        await tournament.save();

        const createMatchChannel = req.app.get('createMatchChannel');
        if (createMatchChannel) {
            for (const mId of matchesIds) {
                const m = await Match.findById(mId);
                if (m) createMatchChannel(m);
            }
        }

        // [NEW] Announce Bracket in Discord
        const sendBracketAnnouncement = req.app.get('sendBracketAnnouncement');
        if (sendBracketAnnouncement) {
            sendBracketAnnouncement(tournament, name, matchesIds.length);
        }

        res.json({ success: true });

    } catch (e) {
        console.error(e);
        res.status(500).json({ msg: e.message });
    }
});

// [NEW] RESOLVE PLACEHOLDERS
router.post('/tournaments/:id/stages/:stageIndex/resolve', auth(['admin']), async (req, res) => {
    try {
        await BracketManager.resolveStagePlaceholders(req.params.id, req.params.stageIndex);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, msg: 'Placeholders resolved based on current standings.' });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// [NEW] UPDATE MATCH PLACEHOLDER (Admin Override)
router.put('/matches/:id/placeholder', auth(['admin']), async (req, res) => {
    try {
        const { side, label, sourceGroupIndex, sourceRank } = req.body; // side = 'teamA' or 'teamB'
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        match[`${side}Placeholder`] = { label, sourceGroupIndex, sourceRank, sourceStageIndex: match[`${side}Placeholder`]?.sourceStageIndex || 0 };
        // If admin manually sets a placeholder, we should probably clear the actual team if it was already resolved, to force re-resolution or manual set
        match[side] = null; 
        
        await match.save();
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ADD MATCH TO STAGE
router.post('/tournaments/:id/stages/:stageIndex/matches', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const { teamA, teamB, format, scheduledTime, name } = req.body;
        const tournament = await Tournament.findById(id);

        const lastMatch = await Match.findOne({ tournament: id }).sort({ matchNumber: -1 });
        const nextNum = (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;

        const newMatch = new Match({
            tournament: id,
            name: name || 'Extra Match',
            matchNumber: nextNum,
            teamA: teamA, teamB: teamB, format: format || 'BO3',
            scheduledTime: scheduledTime || new Date(), status: 'scheduled',
            vetoData: { status: 'pending' }, scores: [], roomPassword: ""
        });
        const savedMatch = await newMatch.save();
        tournament.stages[stageIndex].matches.push(savedMatch._id);
        await tournament.save();

        if (savedMatch.teamA && savedMatch.teamB) {
            const createMatchChannel = req.app.get('createMatchChannel');
            if (createMatchChannel) createMatchChannel(savedMatch);
        }

        req.app.get('io').emit('match_update', savedMatch); 
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, match: savedMatch });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// GENERATE SWISS ROUND
router.post('/tournaments/:id/stages/:stageIndex/swiss-next', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const newMatches = await BracketManager.generateNextSwissRound(id, stageIndex);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, matchesCreated: newMatches.length });
    } catch (e) {
        console.error(e);
        res.status(500).json({ msg: e.message });
    }
});

// UPDATE STAGE SETTINGS
router.put('/tournaments/:id/stages/:stageIndex/settings', auth(['admin']), async (req, res) => {
    try {
        const { settings } = req.body;
        const tournament = await Tournament.findById(req.params.id);
        if (!tournament || !tournament.stages[req.params.stageIndex]) return res.status(404).json({ msg: 'Stage not found' });

        tournament.stages[req.params.stageIndex].settings = {
            ...tournament.stages[req.params.stageIndex].settings,
            ...settings
        };

        await tournament.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// ADD TEAM TO STAGE
router.post('/tournaments/:id/stages/:stageIndex/teams/add', auth(['admin']), async (req, res) => {
    try {
        const { teamId, groupIndex } = req.body;
        await BracketManager.addTeamToStage(req.params.id, req.params.stageIndex, teamId, groupIndex);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// SWAP TEAMS IN STAGE
router.post('/tournaments/:id/stages/:stageIndex/teams/swap', auth(['admin']), async (req, res) => {
    try {
        const { team1Id, team2Id } = req.body;
        await BracketManager.swapTeamsInStage(req.params.id, req.params.stageIndex, team1Id, team2Id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// GET STAGE STANDINGS
router.get('/tournaments/:id/stages/:stageIndex/standings', async (req, res) => {
    try {
        const standings = await BracketManager.getStageStandings(req.params.id, req.params.stageIndex);
        res.json(standings);
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// DELETE STAGE
router.delete('/tournaments/:id/stages/:stageIndex', auth(['admin']), async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id);
        const stageIndex = parseInt(req.params.stageIndex);
        const stage = tournament.stages[stageIndex];
        
        if (stage.matches && stage.matches.length > 0) {
            const matches = await Match.find({ _id: { $in: stage.matches } });
            const deleteMatchChannels = req.app.get('deleteMatchChannels');
            if (deleteMatchChannels) {
                for (const m of matches) await deleteMatchChannels(m);
            }
            await Match.deleteMany({ _id: { $in: stage.matches } });
        }
        
        tournament.stages.splice(stageIndex, 1);
        await tournament.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// DELETE TOURNAMENT
router.delete('/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const tId = req.params.id;

        // [NEW] Clean up channels
        const matches = await Match.find({ tournament: tId });
        const deleteMatchChannels = req.app.get('deleteMatchChannels');
        if (deleteMatchChannels) {
            for (const m of matches) await deleteMatchChannels(m);
        }

        await Match.deleteMany({ tournament: tId });
        await Tournament.findByIdAndDelete(tId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;
