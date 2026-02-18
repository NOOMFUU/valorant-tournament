const express = require('express');
const router = express.Router();

// Import Models
const Match = require('../models/Match');

// --- ROUTES ---

// GET Overlay Data (Public)
router.get('/overlay/match/:id', async (req, res) => {
    try {
        const match = await Match.findById(req.params.id)
            .populate('teamA', 'name shortName logo')
            .populate('teamB', 'name shortName logo')
            .populate('tournament', 'name')
            .populate('vetoData.pickedMaps.pickedBy', 'shortName');

        if (!match) return res.status(404).json({ msg: 'Match not found' });

        let seriesA = 0, seriesB = 0;
        const mapScores = match.scores || [];
        
        // Calculate Series Score
        mapScores.forEach(s => {
            const sA = parseInt(s.teamAScore) || 0;
            const sB = parseInt(s.teamBScore) || 0;
            if (match.status === 'finished') {
                if (sA > sB) seriesA++; else if (sB > sA) seriesB++;
            } else {
                // For live matches, count if map is decisively won
                if ((sA >= 13 && sA >= sB + 2) || (sA > 12 && sB > 12 && sA > sB + 1)) seriesA++;
                else if ((sB >= 13 && sB >= sA + 2) || (sB > 12 && sA > 12 && sB > sA + 1)) seriesB++;
            }
        });

        // Determine Current Map
        let currentMap = null;
        if (match.status === 'live' && match.vetoData && match.vetoData.pickedMaps) {
            const lastScore = mapScores[mapScores.length - 1];
            let lastMapFinished = false;
            if (lastScore) {
                const sA = parseInt(lastScore.teamAScore) || 0;
                const sB = parseInt(lastScore.teamBScore) || 0;
                if ((sA >= 13 && sA >= sB + 2) || (sB >= 13 && sB >= sA + 2) || (sA > 12 && sB > 12 && Math.abs(sA - sB) >= 2)) lastMapFinished = true;
            }
            let mapIndex = lastMapFinished ? mapScores.length : Math.max(0, mapScores.length - 1);
            if (match.vetoData.pickedMaps[mapIndex]) currentMap = match.vetoData.pickedMaps[mapIndex].map;
        }

        const vetoMgr = req.app.get('vetoMgr');
        
        res.json({
            matchId: match._id,
            tournament: match.tournament ? match.tournament.name : '',
            stage: match.name,
            format: match.format,
            status: match.status,
            teamA: { 
                id: match.teamA?._id, 
                name: match.teamA?.name || 'TBD', 
                shortName: match.teamA?.shortName || 'TBD', 
                logo: match.teamA?.logo || '', 
                seriesScore: seriesA 
            },
            teamB: { 
                id: match.teamB?._id, 
                name: match.teamB?.name || 'TBD', 
                shortName: match.teamB?.shortName || 'TBD', 
                logo: match.teamB?.logo || '', 
                seriesScore: seriesB 
            },
            currentMap: currentMap,
            scores: mapScores,
            veto: {
                bans: match.vetoData?.bannedMaps || [],
                picks: match.vetoData?.pickedMaps || [],
                sequence: match.vetoData?.sequence || [],
                status: match.vetoData?.status,
                startTime: match.vetoData?.currentTurnStartTime,
                deadline: match.vetoData?.currentTurnDeadline,
                teamAReady: match.vetoData?.teamAReady,
                teamBReady: match.vetoData?.teamBReady,
                coinTossWinner: match.vetoData?.coinTossWinner
            },
            presence: (vetoMgr && vetoMgr.presence[match._id.toString()]) || {}
        });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

module.exports = router;
