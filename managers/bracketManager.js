const Match = require('../models/Match');
const Stage = require('../models/Stage');
const Group = require('../models/Group');
const StageEntry = require('../models/StageEntry');
const Team = require('../models/Team');

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class BracketManager {

    constructor() {
        this.io = null;
        this.onMatchReady = null; // Callback for channel creation
    }

    setIO(io) {
        this.io = io;
    }

    // Pad teams to the next power of 2 with null (BYE slots)
    padTeams(teams) {
        if (!teams || teams.length === 0) return [];
        const power = Math.pow(2, Math.ceil(Math.log2(teams.length)));
        const padded = [...teams];
        while (padded.length < power) padded.push(null);
        return padded;
    }

    shuffle(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex !== 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    // Next match number for the tournament (continues the sequence)
    async getNextMatchNumber(tournamentId) {
        const lastMatch = await Match.findOne({ tournament: tournamentId }).sort({ matchNumber: -1 });
        return (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;
    }

    // Standard seeding order (1 vs N, 2 vs N-1, ...), returned as 0-based indices
    getSeedingOrder(size) {
        if (size < 2) return [0];
        const rounds = Math.log2(size);
        let seeds = [1, 2];
        for (let i = 0; i < rounds - 1; i++) {
            const nextSeeds = [];
            const sum = Math.pow(2, i + 2) + 1;
            for (let j = 0; j < seeds.length; j++) {
                nextSeeds.push(seeds[j]);
                nextSeeds.push(sum - seeds[j]);
            }
            seeds = nextSeeds;
        }
        return seeds.map(s => s - 1);
    }

    groupLetter(index) {
        return GROUP_LETTERS[index] || String(index + 1);
    }

    // Standings for a Stage (by Stage _id). Null-safe for BYE matches (no teamB).
    async getStageStandings(stageId) {
        const stage = await Stage.findById(stageId);
        if (!stage) return [];

        const [entries, groups, matches] = await Promise.all([
            StageEntry.find({ stage: stageId }).populate('team', 'name shortName logo'),
            Group.find({ stage: stageId }),
            Match.find({ stage: stageId })
        ]);

        const groupById = {};
        groups.forEach(g => { groupById[g._id.toString()] = g; });

        const stats = {};
        entries.forEach(e => {
            if (!e.team) return;
            const id = e.team._id.toString();
            const g = e.group ? groupById[e.group.toString()] : null;
            stats[id] = {
                id: id,
                name: e.team.name,
                shortName: e.team.shortName,
                logo: e.team.logo,
                group: g ? g.order : 0,
                groupName: g ? g.name : '',
                wins: 0, losses: 0, played: 0,
                roundDiff: 0, mapWon: 0, mapLost: 0, mapDiff: 0,
                h2h: {}
            };
        });

        matches.forEach(m => {
            if (m.status !== 'finished' || !m.winner) return;
            const winnerId = m.winner.toString();
            if (!stats[winnerId]) return;

            // BYE: only one side present, no game played
            if (!m.teamA || !m.teamB) {
                stats[winnerId].wins++;
                return;
            }

            const aId = m.teamA.toString();
            const bId = m.teamB.toString();
            const loserId = (winnerId === aId) ? bId : aId;

            stats[winnerId].wins++;
            stats[winnerId].played++;
            stats[winnerId].h2h[loserId] = 'win';

            if (stats[loserId]) {
                stats[loserId].losses++;
                stats[loserId].played++;
                stats[loserId].h2h[winnerId] = 'loss';
            }

            let sA = 0, sB = 0, mapsA = 0, mapsB = 0;
            if (m.scores && m.scores.length > 0) {
                m.scores.forEach(s => {
                    const scA = parseInt(s.teamAScore) || 0;
                    const scB = parseInt(s.teamBScore) || 0;
                    sA += scA; sB += scB;
                    if (scA > scB) mapsA++; else if (scB > scA) mapsB++;
                });
                if (stats[aId]) { stats[aId].roundDiff += (sA - sB); stats[aId].mapWon += mapsA; stats[aId].mapLost += mapsB; stats[aId].mapDiff += (mapsA - mapsB); }
                if (stats[bId]) { stats[bId].roundDiff += (sB - sA); stats[bId].mapWon += mapsB; stats[bId].mapLost += mapsA; stats[bId].mapDiff += (mapsB - mapsA); }
            }
        });

        const tiebreakers = (stage.settings && stage.settings.tiebreakers) || ['h2h', 'map_diff', 'round_diff'];

        return Object.values(stats).sort((a, b) => {
            if (b.wins !== a.wins) return b.wins - a.wins;
            for (const rule of tiebreakers) {
                if (rule === 'h2h') {
                    if (a.h2h[b.id]) return a.h2h[b.id] === 'win' ? -1 : 1;
                } else if (rule === 'map_diff') {
                    if (b.mapDiff !== a.mapDiff) return b.mapDiff - a.mapDiff;
                } else if (rule === 'round_diff') {
                    if (b.roundDiff !== a.roundDiff) return b.roundDiff - a.roundDiff;
                }
            }
            return 0;
        });
    }
}

module.exports = new BracketManager();
