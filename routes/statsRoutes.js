const mongoose = require('mongoose');
const express = require('express');
const router = express.Router();
const PlayerStat = require('../models/PlayerStat');
const Match = require('../models/Match');
const Team = require('../models/Team');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// AUTH: TEAM — Submit player stats for a map
router.post('/matches/:id/stats', auth(['team']), async (req, res) => {
    try {
        const { mapName, players } = req.body;
        const match = await Match.findById(req.params.id).lean();
        if (!match) return res.status(404).json({ success: false, msg: 'Match not found' });
        if (!Array.isArray(players) || players.length === 0)
            return res.status(400).json({ success: false, msg: 'players array is required' });

        const teamId = req.user.id;
        // Only allow teams in this match
        const isTeamA = match.teamA?.toString() === teamId;
        const isTeamB = match.teamB?.toString() === teamId;
        if (!isTeamA && !isTeamB) return res.status(403).json({ success: false, msg: 'Not in this match' });

        // Upsert stats for each player
        const ops = players.map(p => ({
            updateOne: {
                filter: { matchId: match._id, mapName, playerName: p.playerName, playerTag: p.playerTag },
                update: {
                    $set: {
                        teamId,
                        tournamentId: match.tournament,
                        kills: p.kills || 0, deaths: p.deaths || 0, assists: p.assists || 0,
                        acs: p.acs || 0, adr: p.adr || 0, kast: p.kast || 0,
                        firstKills: p.firstKills || 0, firstDeaths: p.firstDeaths || 0,
                        agent: p.agent || '', won: p.won || false
                    }
                },
                upsert: true
            }
        }));
        await PlayerStat.bulkWrite(ops);
        logger.info('PLAYER_STATS_SUBMITTED', { matchId: match._id, mapName, teamId, count: players.length });
        res.json({ success: true, msg: 'Stats saved' });
    } catch (e) {
        logger.error('SUBMIT_STATS_FAIL', { error: e.message, matchId: req.params.id });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get stats for a match
router.get('/matches/:id/stats', async (req, res) => {
    try {
        const stats = await PlayerStat.find({ matchId: req.params.id }).lean();
        res.json(stats);
    } catch (e) {
        logger.error('GET_MATCH_STATS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Get stats for a team (in a tournament)
router.get('/teams/:id/stats', async (req, res) => {
    try {
        const query = { teamId: req.params.id };
        if (req.query.tournamentId) query.tournamentId = req.query.tournamentId;
        const stats = await PlayerStat.find(query).lean();

        // Aggregate per player
        const playerMap = {};
        stats.forEach(s => {
            const key = `${s.playerName}#${s.playerTag}`;
            if (!playerMap[key]) {
                playerMap[key] = {
                    playerName: s.playerName, playerTag: s.playerTag,
                    maps: 0, kills: 0, deaths: 0, assists: 0,
                    acs: 0, adr: 0, kast: 0, wins: 0
                };
            }
            const p = playerMap[key];
            p.maps++;
            p.kills += s.kills; p.deaths += s.deaths; p.assists += s.assists;
            p.acs += s.acs; p.adr += s.adr; p.kast += s.kast;
            if (s.won) p.wins++;
        });

        const aggregated = Object.values(playerMap).map(p => ({
            ...p,
            avgAcs: p.maps ? Math.round(p.acs / p.maps) : 0,
            avgAdr: p.maps ? Math.round(p.adr / p.maps) : 0,
            avgKast: p.maps ? Math.round(p.kast / p.maps) : 0,
            kd: p.deaths ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2)
        }));

        aggregated.sort((a, b) => b.avgAcs - a.avgAcs);
        res.json(aggregated);
    } catch (e) {
        logger.error('GET_TEAM_STATS_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

// AUTH: PUBLIC — Tournament leaderboard (top players by ACS)
router.get('/tournaments/:id/leaderboard', async (req, res) => {
    try {
        const stats = await PlayerStat.aggregate([
            { $match: { tournamentId: new mongoose.Types.ObjectId(req.params.id) } },
            {
                $group: {
                    _id: { playerName: '$playerName', playerTag: '$playerTag', teamId: '$teamId' },
                    maps: { $sum: 1 },
                    totalKills: { $sum: '$kills' },
                    totalDeaths: { $sum: '$deaths' },
                    totalAssists: { $sum: '$assists' },
                    totalAcs: { $sum: '$acs' },
                    totalAdr: { $sum: '$adr' },
                    totalKast: { $sum: '$kast' },
                    wins: { $sum: { $cond: ['$won', 1, 0] } }
                }
            },
            {
                $project: {
                    playerName: '$_id.playerName', playerTag: '$_id.playerTag',
                    teamId: '$_id.teamId', maps: 1,
                    totalKills: 1, totalDeaths: 1, totalAssists: 1, wins: 1,
                    avgAcs: { $round: [{ $divide: ['$totalAcs', '$maps'] }, 0] },
                    avgAdr: { $round: [{ $divide: ['$totalAdr', '$maps'] }, 0] },
                    avgKast: { $round: [{ $divide: ['$totalKast', '$maps'] }, 0] },
                    kd: { $round: [{ $cond: [{ $gt: ['$totalDeaths', 0] }, { $divide: ['$totalKills', '$totalDeaths'] }, '$totalKills'] }, 2] }
                }
            },
            { $sort: { avgAcs: -1 } },
            { $limit: 50 }
        ]);

        // Populate team names
        const teamIds = [...new Set(stats.map(s => s.teamId?.toString()).filter(Boolean))];
        const teams = await Team.find({ _id: { $in: teamIds } }).select('name shortName logo').lean();
        const teamMap = {};
        teams.forEach(t => { teamMap[t._id.toString()] = t; });
        const result = stats.map(s => ({ ...s, team: teamMap[s.teamId?.toString()] || null }));

        res.json(result);
    } catch (e) {
        logger.error('GET_LEADERBOARD_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: e.message });
    }
});

module.exports = router;
