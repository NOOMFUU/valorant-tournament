const express = require('express');
const router = express.Router();
const Tournament = require('../models/Tournament');
const Match = require('../models/Match');
const Team = require('../models/Team');
const BracketManager = require('../managers/bracketManager');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// AUTH: PUBLIC — Get all tournaments (non-archived)
router.get('/tournaments', async (req, res) => {
    try {
        const t = await Tournament.find({ isArchived: { $ne: true } })
            .populate('participants').sort({ createdAt: -1 });
        res.json(t);
    } catch (e) {
        logger.error('GET_TOURNAMENTS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get public tournament data
router.get('/tournaments/:id/public', async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id)
            .select('-stages.matches.roomPassword -stages.matches.chat')
            .populate({ path: 'participants', select: 'name shortName logo wins losses' })
            .populate({
                path: 'stages.matches',
                populate: { path: 'teamA teamB winner', select: 'name shortName logo' },
                select: '-roomPassword -chat -vetoData.history'
            });
        if (!tournament) return res.status(404).json({ success: false, msg: 'Tournament not found' });
        res.json(tournament);
    } catch (e) {
        logger.error('GET_TOURNAMENT_PUBLIC_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get map analytics
router.get('/analytics/maps', async (req, res) => {
    try {
        const matches = await Match.find({ 'vetoData': { $exists: true } }).lean();
        const stats = {};
        matches.forEach(m => {
            if (m.vetoData && m.vetoData.log) {
                m.vetoData.log.forEach(log => {
                    const action = log.action;
                    const mapName = log.map;
                    if (mapName && action) {
                        if (!stats[mapName]) stats[mapName] = { picks: 0, bans: 0, winsA: 0, winsB: 0, totalPlayed: 0 };
                        if (action === 'ban') stats[mapName].bans++;
                        if (action === 'pick' || action === 'random_pick') stats[mapName].picks++;
                    }
                });
            }
            if (m.scores && m.scores.length > 0) {
                m.scores.forEach(s => {
                    if (!stats[s.mapName]) stats[s.mapName] = { picks: 0, bans: 0, winsA: 0, winsB: 0, totalPlayed: 0 };
                    stats[s.mapName].totalPlayed++;
                    if (s.teamAScore > s.teamBScore) stats[s.mapName].winsA++;
                    if (s.teamBScore > s.teamAScore) stats[s.mapName].winsB++;
                });
            }
        });
        res.json(stats);
    } catch (e) {
        logger.error('GET_MAP_ANALYTICS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Head-to-head stats
router.get('/analytics/h2h/:team1/:team2', async (req, res) => {
    try {
        const { team1, team2 } = req.params;
        const matches = await Match.find({
            status: 'finished',
            $or: [
                { teamA: team1, teamB: team2 },
                { teamA: team2, teamB: team1 }
            ]
        }).lean();
        let wins1 = 0, wins2 = 0;
        matches.forEach(m => {
            if (m.winner) {
                if (m.winner.toString() === team1) wins1++;
                else if (m.winner.toString() === team2) wins2++;
            }
        });
        res.json({ team1Wins: wins1, team2Wins: wins2, totalMatches: matches.length });
    } catch (e) {
        logger.error('GET_H2H_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Create tournament (FIXED: no longer deletes all tournaments)
router.post('/tournaments', auth(['admin']), async (req, res) => {
    try {
        const { name, teamIds, mapPool } = req.body;
        if (!name) return res.status(400).json({ success: false, msg: 'Tournament name is required' });

        const tournament = new Tournament({
            name,
            participants: teamIds || [],
            mapPool: mapPool || ['Abyss', 'Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Pearl'],
            status: 'active'
        });
        await tournament.save();
        logger.info('TOURNAMENT_CREATED', { tournamentId: tournament._id, name });
        res.json({ success: true, id: tournament._id });
    } catch (e) {
        logger.error('CREATE_TOURNAMENT_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Update tournament
router.put('/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const { name, mapPool, prizePool, formatDescription, rules, status } = req.body;
        const update = {};
        if (name !== undefined) update.name = name;
        if (mapPool !== undefined) update.mapPool = mapPool;
        if (prizePool !== undefined) update.prizePool = prizePool;
        if (formatDescription !== undefined) update.formatDescription = formatDescription;
        if (rules !== undefined) update.rules = rules;
        if (status !== undefined) update.status = status;
        await Tournament.findByIdAndUpdate(req.params.id, update);
        res.json({ success: true });
    } catch (e) {
        logger.error('UPDATE_TOURNAMENT_FAIL', { error: e.message, tournamentId: req.params.id });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Update registration settings
router.put('/tournaments/:id/registration', auth(['admin']), async (req, res) => {
    try {
        const { isOpen, deadline, maxTeams, requiresApproval, description, contactDiscord } = req.body;
        const update = {};
        if (isOpen !== undefined) update['registration.isOpen'] = isOpen;
        if (deadline !== undefined) update['registration.deadline'] = deadline ? new Date(deadline) : null;
        if (maxTeams !== undefined) update['registration.maxTeams'] = maxTeams;
        if (requiresApproval !== undefined) update['registration.requiresApproval'] = requiresApproval;
        if (description !== undefined) update['registration.description'] = description;
        if (contactDiscord !== undefined) update['registration.contactDiscord'] = contactDiscord;
        await Tournament.findByIdAndUpdate(req.params.id, update);
        logger.info('REGISTRATION_SETTINGS_UPDATED', { tournamentId: req.params.id });
        res.json({ success: true, msg: 'Registration settings updated' });
    } catch (e) {
        logger.error('UPDATE_REGISTRATION_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get tournament registration info
router.get('/tournaments/:id/registration', async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id)
            .select('name registration participants').lean();
        if (!tournament) return res.status(404).json({ success: false, msg: 'Tournament not found' });
        const registeredCount = (tournament.participants || []).length;
        res.json({ success: true, data: { ...tournament, registeredCount } });
    } catch (e) {
        logger.error('GET_REGISTRATION_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Archive a tournament
router.post('/tournaments/:id/archive', auth(['admin']), async (req, res) => {
    try {
        await Tournament.findByIdAndUpdate(req.params.id, {
            isArchived: true,
            archivedAt: new Date(),
            status: 'finished'
        });
        logger.info('TOURNAMENT_ARCHIVED', { tournamentId: req.params.id });
        res.json({ success: true, msg: 'Tournament archived' });
    } catch (e) {
        logger.error('ARCHIVE_TOURNAMENT_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — List archived tournaments
router.get('/tournaments/archived', async (req, res) => {
    try {
        const archived = await Tournament.find({ isArchived: true })
            .select('name archivedAt status createdAt').sort({ archivedAt: -1 }).lean();
        res.json(archived);
    } catch (e) {
        logger.error('GET_ARCHIVED_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Generate stage
router.post('/tournaments/:id/stages/generate', auth(['admin']), async (req, res) => {
    try {
        const { name, type, participants, settings } = req.body;
        const tournament = await Tournament.findById(req.params.id).populate({
            path: 'stages.matches',
            populate: { path: 'teamA teamB winner' }
        });

        let finalParticipants = [];

        if (settings.sourceStageIndex >= 0 && tournament.stages[settings.sourceStageIndex] && !settings.usePlaceholders) {
            const sourceStage = tournament.stages[settings.sourceStageIndex];
            const sourceMatches = sourceStage.matches;

            if (sourceStage.type === 'gsl' && settings.advanceMethod === 'cross_group') {
                const groupWinners = [], groupRunnersUp = [];
                sourceMatches.forEach(m => {
                    if (m.status === 'finished' && m.winner) {
                        if (m.name.includes('Winners')) groupWinners.push({ team: m.winner, match: m });
                        if (m.name.includes('Decider')) groupRunnersUp.push({ team: m.winner, match: m });
                    }
                });
                const getGroupChar = (n) => n.split('Group ')[1]?.[0] || 'Z';
                groupWinners.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));
                groupRunnersUp.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));
                finalParticipants = [...groupWinners.map(x => x.team), ...groupRunnersUp.map(x => x.team)];
                const teamsDb = await Team.find({ _id: { $in: finalParticipants } });
                finalParticipants = finalParticipants.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);
            } else if (['round_robin', 'swiss'].includes(sourceStage.type)) {
                const standings = await BracketManager.getStageStandings(tournament._id, settings.sourceStageIndex);
                const grouped = {};
                standings.forEach(s => { const g = s.group || 'A'; if (!grouped[g]) grouped[g] = []; grouped[g].push(s); });
                const count = settings.advanceCount || 2;
                const selectedIds = [];
                Object.keys(grouped).sort().forEach(g => { grouped[g].slice(0, count).forEach(s => selectedIds.push(s.id)); });
                const teamsDb = await Team.find({ _id: { $in: selectedIds } });
                finalParticipants = selectedIds.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);
            } else {
                const teamsDb = await Team.find({ _id: { $in: participants || [] } });
                finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
            }
        } else {
            const teamsDb = await Team.find({ _id: { $in: participants } });
            finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
        }

        if (settings.usePlaceholders) finalParticipants = [];

        if (type === 'triple_elim' && settings.teamCount) {
            const teamCount = parseInt(settings.teamCount, 10);
            if (!Number.isNaN(teamCount) && teamCount > 0 && finalParticipants.length >= teamCount) {
                finalParticipants = finalParticipants.slice(0, teamCount);
            }
        }

        const matchesIds = await BracketManager.generateStage(tournament._id, name, type, finalParticipants, settings);
        tournament.stages.push({ name, type, settings, stageParticipants: finalParticipants.map(t => t._id), matches: matchesIds });
        await tournament.save();

        const createMatchChannel = req.app.get('createMatchChannel');
        if (createMatchChannel) { for (const mId of matchesIds) { const m = await Match.findById(mId); if (m) createMatchChannel(m); } }

        const sendBracketAnnouncement = req.app.get('sendBracketAnnouncement');
        if (sendBracketAnnouncement) sendBracketAnnouncement(tournament, name, matchesIds.length);

        logger.info('STAGE_GENERATED', { tournamentId: req.params.id, name, type, matchCount: matchesIds.length });
        res.json({ success: true });
    } catch (e) {
        logger.error('GENERATE_STAGE_FAIL', { error: e.message, stack: e.stack });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Resolve placeholders
router.post('/tournaments/:id/stages/:stageIndex/resolve', auth(['admin']), async (req, res) => {
    try {
        await BracketManager.resolveStagePlaceholders(req.params.id, req.params.stageIndex);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, msg: 'Placeholders resolved based on current standings.' });
    } catch (e) {
        logger.error('RESOLVE_PLACEHOLDERS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Update match placeholder
router.put('/matches/:id/placeholder', auth(['admin']), async (req, res) => {
    try {
        const { side, label, sourceGroupIndex, sourceRank } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ success: false, msg: 'Match not found' });
        match[`${side}Placeholder`] = { label, sourceGroupIndex, sourceRank, sourceStageIndex: match[`${side}Placeholder`]?.sourceStageIndex || 0 };
        match[side] = null;
        await match.save();
        req.app.get('io').emit('match_update', match);
        res.json({ success: true });
    } catch (e) {
        logger.error('UPDATE_PLACEHOLDER_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Add match to stage
router.post('/tournaments/:id/stages/:stageIndex/matches', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const { teamA, teamB, format, scheduledTime, name } = req.body;
        const tournament = await Tournament.findById(id);
        const lastMatch = await Match.findOne({ tournament: id }).sort({ matchNumber: -1 }).lean();
        const nextNum = (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;
        const newMatch = new Match({
            tournament: id, name: name || 'Extra Match', matchNumber: nextNum,
            teamA, teamB, format: format || 'BO3',
            scheduledTime: scheduledTime || new Date(), status: 'scheduled',
            vetoData: { status: 'pending' }, scores: [], roomPassword: ''
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
    } catch (e) {
        logger.error('ADD_MATCH_TO_STAGE_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Generate swiss round
router.post('/tournaments/:id/stages/:stageIndex/swiss-next', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const newMatches = await BracketManager.generateNextSwissRound(id, stageIndex);
        req.app.get('io').emit('bracket_update');
        res.json({ success: true, matchesCreated: newMatches.length });
    } catch (e) {
        logger.error('SWISS_NEXT_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Update stage settings
router.put('/tournaments/:id/stages/:stageIndex/settings', auth(['admin']), async (req, res) => {
    try {
        const { settings } = req.body;
        const tournament = await Tournament.findById(req.params.id);
        if (!tournament || !tournament.stages[req.params.stageIndex]) return res.status(404).json({ success: false, msg: 'Stage not found' });
        tournament.stages[req.params.stageIndex].settings = { ...tournament.stages[req.params.stageIndex].settings, ...settings };
        await tournament.save();
        res.json({ success: true });
    } catch (e) {
        logger.error('UPDATE_STAGE_SETTINGS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Add team to stage
router.post('/tournaments/:id/stages/:stageIndex/teams/add', auth(['admin']), async (req, res) => {
    try {
        const { teamId, groupIndex } = req.body;
        await BracketManager.addTeamToStage(req.params.id, req.params.stageIndex, teamId, groupIndex);
        res.json({ success: true });
    } catch (e) {
        logger.error('ADD_TEAM_TO_STAGE_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Swap teams in stage
router.post('/tournaments/:id/stages/:stageIndex/teams/swap', auth(['admin']), async (req, res) => {
    try {
        const { team1Id, team2Id } = req.body;
        await BracketManager.swapTeamsInStage(req.params.id, req.params.stageIndex, team1Id, team2Id);
        res.json({ success: true });
    } catch (e) {
        logger.error('SWAP_TEAMS_IN_STAGE_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get stage standings
router.get('/tournaments/:id/stages/:stageIndex/standings', async (req, res) => {
    try {
        const standings = await BracketManager.getStageStandings(req.params.id, req.params.stageIndex);
        res.json(standings);
    } catch (e) {
        logger.error('GET_STANDINGS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Delete stage
router.delete('/tournaments/:id/stages/:stageIndex', auth(['admin']), async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id);
        const stageIndex = parseInt(req.params.stageIndex);
        const stage = tournament.stages[stageIndex];
        if (stage.matches && stage.matches.length > 0) {
            const matches = await Match.find({ _id: { $in: stage.matches } });
            const deleteMatchChannels = req.app.get('deleteMatchChannels');
            if (deleteMatchChannels) for (const m of matches) await deleteMatchChannels(m);
            await Match.deleteMany({ _id: { $in: stage.matches } });
        }
        tournament.stages.splice(stageIndex, 1);
        await tournament.save();
        res.json({ success: true });
    } catch (e) {
        logger.error('DELETE_STAGE_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Delete tournament
router.delete('/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const tId = req.params.id;
        const matches = await Match.find({ tournament: tId });
        const deleteMatchChannels = req.app.get('deleteMatchChannels');
        if (deleteMatchChannels) for (const m of matches) await deleteMatchChannels(m);
        await Match.deleteMany({ tournament: tId });
        await Tournament.findByIdAndDelete(tId);
        logger.info('TOURNAMENT_DELETED', { tournamentId: tId });
        res.json({ success: true });
    } catch (e) {
        logger.error('DELETE_TOURNAMENT_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: TEAM — Verify score (opposing team confirms)
router.post('/matches/:id/verify-score', auth(['team']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ success: false, msg: 'Match not found' });
        if (match.status !== 'pending_approval') return res.status(400).json({ success: false, msg: 'Match not pending approval' });

        match.status = 'finished';
        match.scores = match.scoreSubmission.tempScores;
        let winsA = 0, winsB = 0;
        match.scores.forEach(s => {
            if (parseInt(s.teamAScore) > parseInt(s.teamBScore)) winsA++;
            else if (parseInt(s.teamBScore) > parseInt(s.teamAScore)) winsB++;
        });
        match.winner = winsA > winsB ? match.teamA : match.teamB;
        await match.save();
        await BracketManager.updateMatch(match);
        req.app.get('io').emit('match_update', match);
        req.app.get('io').emit('bracket_update');
        logger.info('SCORE_TEAM_VERIFIED', { matchId: match._id, teamId: req.user.id });
        res.json({ success: true });
    } catch (e) {
        logger.error('VERIFY_SCORE_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// ============================================================
// REGISTRATION SYSTEM — PUBLIC SUBMISSION
// ============================================================

// AUTH: PUBLIC — Get tournament access type + registration status (safe public view)
router.get('/tournaments/:id/access', async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id)
            .select('name accessType registration participants status').lean();
        if (!t) return res.status(404).json({ success: false, msg: 'Not found' });
        const slotsLeft = t.registration.maxTeams - (t.participants || []).length;
        const deadlinePassed = t.registration.deadline && new Date() > new Date(t.registration.deadline);
        res.json({
            success: true,
            data: {
                name: t.name,
                status: t.status,
                accessType: t.accessType,
                registration: {
                    isOpen: t.registration.isOpen && !deadlinePassed && slotsLeft > 0,
                    deadline: t.registration.deadline,
                    maxTeams: t.registration.maxTeams,
                    slotsLeft: Math.max(0, slotsLeft),
                    requiresApproval: t.registration.requiresApproval,
                    description: t.registration.description,
                    contactDiscord: t.registration.contactDiscord
                }
            }
        });
    } catch (e) {
        logger.error('GET_TOURNAMENT_ACCESS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Submit a registration (open or invite_only with code)
router.post('/tournaments/:id/register', async (req, res) => {
    try {
        const { teamName, contactName, contactDiscord, members, inviteCode } = req.body;
        if (!teamName || !contactName) {
            return res.status(400).json({ success: false, msg: 'Team name and contact name are required' });
        }

        const t = await Tournament.findById(req.params.id);
        if (!t) return res.status(404).json({ success: false, msg: 'Tournament not found' });

        // Access control checks
        if (t.accessType === 'private') {
            return res.status(403).json({ success: false, msg: 'This tournament is invite-only. Contact the organizer.' });
        }
        if (t.accessType === 'invite_only') {
            if (!inviteCode || inviteCode.toUpperCase().trim() !== t.inviteCode.toUpperCase().trim()) {
                return res.status(403).json({ success: false, msg: 'Invalid invite code.' });
            }
        }
        if (!t.registration.isOpen) {
            return res.status(400).json({ success: false, msg: 'Registration is currently closed.' });
        }
        if (t.registration.deadline && new Date() > new Date(t.registration.deadline)) {
            return res.status(400).json({ success: false, msg: 'Registration deadline has passed.' });
        }
        const slotsLeft = t.registration.maxTeams - (t.participants || []).length;
        if (slotsLeft <= 0) {
            return res.status(400).json({ success: false, msg: 'Tournament is full.' });
        }
        // Duplicate check
        const alreadyPending = t.pendingRegistrations.some(
            r => r.teamName.toLowerCase() === teamName.toLowerCase() && r.status === 'pending'
        );
        if (alreadyPending) {
            return res.status(400).json({ success: false, msg: 'A registration with this team name is already pending.' });
        }

        const reg = {
            teamName: teamName.trim(),
            contactName: contactName.trim(),
            contactDiscord: contactDiscord || '',
            members: (members || []).map(m => ({
                name: m.name || '',
                riotId: m.riotId || '',
                role: m.role || 'Main'
            })),
            status: 'pending',
            inviteCode: inviteCode || ''
        };
        t.pendingRegistrations.push(reg);
        await t.save();

        logger.info('TOURNAMENT_REGISTRATION_SUBMITTED', {
            tournamentId: t._id, teamName, accessType: t.accessType
        });
        res.json({ success: true, msg: 'Registration submitted! Waiting for admin approval.' });
    } catch (e) {
        logger.error('SUBMIT_REGISTRATION_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — List all pending registrations for a tournament
router.get('/tournaments/:id/registrations', auth(['admin']), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id)
            .select('name pendingRegistrations participants').lean();
        if (!t) return res.status(404).json({ success: false, msg: 'Not found' });
        res.json({ success: true, data: t.pendingRegistrations || [] });
    } catch (e) {
        logger.error('GET_REGISTRATIONS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Approve a pending registration (creates Team account)
router.post('/tournaments/:id/registrations/:regId/approve', auth(['admin']), async (req, res) => {
    try {
        const t = await Tournament.findById(req.params.id);
        if (!t) return res.status(404).json({ success: false, msg: 'Tournament not found' });

        const reg = t.pendingRegistrations.id(req.params.regId);
        if (!reg) return res.status(404).json({ success: false, msg: 'Registration not found' });
        if (reg.status !== 'pending') {
            return res.status(400).json({ success: false, msg: `Registration is already ${reg.status}` });
        }

        const bcrypt = require('bcryptjs');
        const User = require('../models/User');

        // Create a Team user account with auto-generated password
        const tempPassword = Math.random().toString(36).slice(-8).toUpperCase();
        const hashed = await bcrypt.hash(tempPassword, 10);
        const teamUser = new User({
            username: reg.teamName.replace(/\s+/g, '_').toLowerCase(),
            password: hashed,
            role: 'team',
            teamName: reg.teamName
        });
        await teamUser.save();

        // Create the Team document
        const Team = require('../models/Team');
        const team = new Team({
            name: reg.teamName,
            shortName: reg.teamName.replace(/\s+/g, '').substring(0, 4).toUpperCase(),
            members: reg.members.map(m => ({
                name: m.name, riotId: m.riotId, role: m.role
            })),
            userId: teamUser._id
        });
        await team.save();

        // Link user → team
        teamUser.teamId = team._id;
        await teamUser.save();

        // Add to tournament participants
        t.participants.push(team._id);
        reg.status = 'approved';
        await t.save();

        logger.info('REGISTRATION_APPROVED', {
            tournamentId: t._id, teamId: team._id, teamName: reg.teamName
        });

        // Emit real-time update
        const io = req.app.get('io');
        if (io) io.emit('bracket_update', { tournamentId: t._id });

        res.json({
            success: true,
            msg: `Team "${reg.teamName}" approved!`,
            data: { teamId: team._id, tempCredentials: { username: teamUser.username, password: tempPassword } }
        });
    } catch (e) {
        logger.error('APPROVE_REGISTRATION_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Reject a pending registration
router.post('/tournaments/:id/registrations/:regId/reject', auth(['admin']), async (req, res) => {
    try {
        const { reason } = req.body;
        const t = await Tournament.findById(req.params.id);
        if (!t) return res.status(404).json({ success: false, msg: 'Not found' });

        const reg = t.pendingRegistrations.id(req.params.regId);
        if (!reg) return res.status(404).json({ success: false, msg: 'Registration not found' });

        reg.status = 'rejected';
        reg.rejectionReason = reason || 'No reason provided';
        await t.save();

        logger.info('REGISTRATION_REJECTED', { tournamentId: t._id, regId: req.params.regId, reason });
        res.json({ success: true, msg: 'Registration rejected.' });
    } catch (e) {
        logger.error('REJECT_REGISTRATION_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: ADMIN — Set access type + regenerate invite code
router.put('/tournaments/:id/access', auth(['admin']), async (req, res) => {
    try {
        const { accessType, regenerateCode } = req.body;
        const t = await Tournament.findById(req.params.id);
        if (!t) return res.status(404).json({ success: false, msg: 'Not found' });

        if (accessType) t.accessType = accessType;
        if (regenerateCode || (accessType === 'invite_only' && !t.inviteCode)) {
            const crypto = require('crypto');
            t.inviteCode = crypto.randomBytes(5).toString('hex').toUpperCase();
        }
        if (accessType !== 'invite_only') t.inviteCode = '';
        await t.save();

        logger.info('TOURNAMENT_ACCESS_UPDATED', { tournamentId: t._id, accessType });
        res.json({ success: true, msg: 'Access settings updated', inviteCode: t.inviteCode });
    } catch (e) {
        logger.error('UPDATE_ACCESS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

module.exports = router;
