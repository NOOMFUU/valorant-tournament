const Tournament = require('../models/Tournament');
const Match = require('../models/Match');

/**
 * Middleware to check if the user has permission to manage a tournament.
 * Works for both direct tournament routes and sub-resources like matches.
 */
const checkTournamentAccess = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const userRole = req.user.role;
        
        // System Admins (if any) could bypass this, but for now we follow the owner/collaborator logic
        let tournamentId = req.params.tournamentId || req.params.id;

        // If it's a match route, find the tournament ID first
        if (req.params.matchId || (req.baseUrl.includes('matches') && req.params.id)) {
            const matchId = req.params.matchId || req.params.id;
            const match = await Match.findById(matchId);
            if (!match) return res.status(404).json({ msg: 'Match not found' });
            tournamentId = match.tournament;
        }

        const tournament = await Tournament.findById(tournamentId);
        if (!tournament) return res.status(404).json({ msg: 'Tournament not found' });

        const isOwner = tournament.owner.toString() === userId;
        const isCollaborator = tournament.collaborators.some(id => id.toString() === userId);

        if (!isOwner && !isCollaborator) {
            return res.status(403).json({ msg: 'Unauthorized: You do not have permission to manage this tournament' });
        }

        // Attach tournament to request for further use if needed
        req.managedTournament = tournament;
        next();
    } catch (e) {
        res.status(500).json({ msg: 'Authorization Error: ' + e.message });
    }
};

module.exports = { checkTournamentAccess };
