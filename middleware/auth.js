const jwt = require('jsonwebtoken');
const Team = require('../models/Team');

const auth = (roles = []) => async (req, res, next) => {
    let t = req.headers['authorization'];
    if (!t) return res.status(401).json({ msg: 'No token' });
    if (t.startsWith('Bearer ')) t = t.slice(7, t.length);

    try {
        const d = jwt.verify(t, process.env.JWT_SECRET);
        if (d.role === 'team') {
            const team = await Team.findById(d.id);
            if (!team || team.status !== 'approved') return res.status(403).json({ msg: 'Team not authorized' });
        }
        if (roles.length && !roles.includes(d.role)) return res.status(403).json({ msg: 'Forbidden' });
        req.user = d;
        next();
    } catch { res.status(401).json({ msg: 'Invalid Token' }); }
};

module.exports = auth;
