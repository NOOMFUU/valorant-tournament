const express = require('express');
const router = express.Router();

module.exports = (io) => {
    // Endpoint to trigger audio events in a match lobby
    // POST /api/matches/:matchId/audio
    router.post('/matches/:matchId/audio', (req, res) => {
        const { matchId } = req.params;
        const { sound } = req.body; // 'turn', 'action', 'tick', 'ready'

        if (!matchId || !sound) return res.status(400).json({ success: false, msg: 'Missing parameters' });

        // Emit to the specific match room
        io.to(matchId).emit('play_audio', { sound });
        res.json({ success: true });
    });

    return router;
};