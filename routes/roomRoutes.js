const express = require('express');
const router = express.Router();
const Match = require('../models/Match');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// AUTH: TEAM (participants of the match) / ADMIN — Get lobby credentials
// roomPassword is excluded from the Match schema by default (select: false),
// so it is only returned here, and only to the two teams in the match or an admin.
router.get('/matches/:id/room', auth(['team', 'admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id)
            .select('+roomPassword roomName teamA teamB')
            .lean();
        if (!match) return res.status(404).json({ success: false, msg: 'Match not found' });

        if (req.user.role !== 'admin') {
            const userId = String(req.user.id);
            const isParticipant = [match.teamA, match.teamB].some(t => t && String(t) === userId);
            if (!isParticipant) {
                return res.status(403).json({ success: false, msg: 'You are not a participant in this match' });
            }
        }

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            data: {
                roomName: match.roomName || '',
                roomPassword: match.roomPassword || ''
            }
        });
    } catch (e) {
        logger.error('GET_MATCH_ROOM_FAIL', { error: e.message });
        res.status(500).json({ success: false, msg: 'Failed to load room credentials' });
    }
});

module.exports = router;
