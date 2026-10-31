const Match = require('../models/Match');
const Stage = require('../models/Stage');
const Group = require('../models/Group');
const StageEntry = require('../models/StageEntry');
const Team = require('../models/Team');

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

class BracketManager {

    constructor() {
        this.io = null;
        this.onMatchReady = null;
    }

    setIO(io) {
        this.io = io;
    }

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

    async getNextMatchNumber(tournamentId) {
        const lastMatch = await Match.findOne({ tournament: tournamentId }).sort({ matchNumber: -1 });
        return (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;
    }

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

    // ---- Relational helpers ----

    async createGroups(stage, count, names = []) {
        const groups = [];
        for (let i = 0; i < count; i++) {
            let name = names[i];
            if (!name) name = count > 1 ? `Group ${this.groupLetter(i)}` : 'Main';
            const group = await Group.create({ stage: stage._id, order: i, name: name });
            groups.push(group);
        }
        return groups;
    }

    async createStageEntries(stage, teams, group = null) {
        const docs = teams.filter(Boolean).map(team => ({
            stage: stage._id,
            group: group ? group._id : null,
            team: team._id
        }));
        if (docs.length > 0) await StageEntry.insertMany(docs);
        return docs;
    }

    async createMatchDoc(tournamentId, stage, group, data) {
        const cfg = stage.settings || {};
        const m = new Match({
            tournament: tournamentId,
            stage: stage._id,
            group: group ? group._id : null,
            name: data.name,
            matchNumber: data.matchNumber,
            round: data.round,
            matchOrder: data.matchOrder,
            teamA: data.teamA ? data.teamA._id : null,
            teamB: data.teamB ? data.teamB._id : null,
            teamARoster: data.teamA ? data.teamA.members : [],
            teamBRoster: data.teamB ? data.teamB.members : [],
            format: data.format || cfg.defaultFormat || 'BO1',
            status: 'scheduled',
            vetoData: { status: 'pending' }
        });
        await m.save();
        return m;
    }

    // BYE: teamA advances automatically, no game played
    async createByeMatch(tournamentId, stage, group, data) {
        const m = await this.createMatchDoc(tournamentId, stage, group, { ...data, teamB: null });
        m.status = 'bye';
        m.winner = data.teamA._id;
        await m.save();
        return m;
    }

    // ---- ROUND ROBIN ----

    async generateRoundRobin(tournamentId, stage, teams) {
        const cfg = stage.settings || {};
        const groupCount = cfg.groupCount || 1;
        const groups = await this.createGroups(stage, groupCount, cfg.groupNames || []);
        const buckets = groups.map(() => []);
        teams.filter(Boolean).forEach((t, i) => buckets[i % groupCount].push(t));

        let num = await this.getNextMatchNumber(tournamentId);
        const created = [];

        for (let g = 0; g < groups.length; g++) {
            const group = groups[g];
            const prefix = groupCount > 1 ? `${stage.name} ${group.name}` : stage.name;
            const pool = [...buckets[g]];
            await this.createStageEntries(stage, pool, group);
            if (pool.length % 2 !== 0) pool.push(null);

            const n = pool.length;
            const roundsPerLeg = n - 1;
            const legs = cfg.roundCount || 1;

            for (let leg = 0; leg < legs; leg++) {
                let rotation = [...pool];
                for (let r = 0; r < roundsPerLeg; r++) {
                    const roundNum = r + 1 + leg * roundsPerLeg;
                    for (let m = 0; m < n / 2; m++) {
                        const tA = rotation[m];
                        const tB = rotation[n - 1 - m];
                        if (!tA || !tB) continue;
                        const home = leg % 2 === 0 ? tA : tB;
                        const away = leg % 2 === 0 ? tB : tA;
                        const match = await this.createMatchDoc(tournamentId, stage, group, {
                            name: `${prefix}: Round ${roundNum}`,
                            matchNumber: num++,
                            round: roundNum,
                            matchOrder: m,
                            teamA: home,
                            teamB: away
                        });
                        created.push(match._id);
                    }
                    rotation.splice(1, 0, rotation.pop());
                }
            }
        }
        return created;
    }

    // ---- SWISS ----

    async generateSwissRound1(tournamentId, stage, teams) {
        const cfg = stage.settings || {};
        const list = teams.filter(Boolean);
        if (cfg.randomize) this.shuffle(list);
        await this.createStageEntries(stage, list, null);

        let num = await this.getNextMatchNumber(tournamentId);
        const created = [];
        for (let i = 0; i + 1 < list.length; i += 2) {
            const m = await this.createMatchDoc(tournamentId, stage, null, {
                name: `${stage.name}: R1-M${Math.floor(i / 2) + 1}`,
                matchNumber: num++,
                round: 1,
                matchOrder: Math.floor(i / 2),
                teamA: list[i],
                teamB: list[i + 1]
            });
            created.push(m._id);
        }
        if (list.length % 2 !== 0) {
            const last = list[list.length - 1];
            const bye = await this.createByeMatch(tournamentId, stage, null, {
                name: `${stage.name}: R1-Bye`,
                matchNumber: num++,
                round: 1,
                matchOrder: Math.floor(list.length / 2),
                teamA: last
            });
            created.push(bye._id);
        }
        return created;
    }

    // Pairs teams by current standings, avoiding rematches and repeated byes
    async generateNextSwissRound(tournamentId, stageId, roundNumber) {
        const stage = await Stage.findById(stageId);
        if (!stage) throw new Error('Stage not found');

        const standings = await this.getStageStandings(stageId);
        const matches = await Match.find({ stage: stageId });

        const played = new Set();
        const hadBye = new Set();
        matches.forEach(m => {
            if (m.teamA && m.teamB) {
                const a = m.teamA.toString();
                const b = m.teamB.toString();
                played.add(a + '|' + b);
                played.add(b + '|' + a);
            } else if (m.teamA && !m.teamB) {
                hadBye.add(m.teamA.toString());
            }
        });

        const pool = standings.map(s => s.id);
        let byeId = null;
        if (pool.length % 2 !== 0) {
            for (let i = pool.length - 1; i >= 0; i--) {
                if (!hadBye.has(pool[i])) {
                    byeId = pool[i];
                    pool.splice(i, 1);
                    break;
                }
            }
            if (!byeId) byeId = pool.pop();
        }

        const pairs = [];
        const unpaired = [...pool];
        while (unpaired.length > 0) {
            const a = unpaired.shift();
            let idx = unpaired.findIndex(b => !played.has(a + '|' + b));
            if (idx === -1) idx = 0; // no fresh opponent left, accept a rematch
            const b = unpaired.splice(idx, 1)[0];
            pairs.push([a, b]);
        }

        const teamDocs = await Team.find({ _id: { $in: standings.map(s => s.id) } });
        const byId = {};
        teamDocs.forEach(t => { byId[t._id.toString()] = t; });

        let num = await this.getNextMatchNumber(tournamentId);
        const created = [];
        for (let i = 0; i < pairs.length; i++) {
            const m = await this.createMatchDoc(tournamentId, stage, null, {
                name: `${stage.name}: R${roundNumber}-M${i + 1}`,
                matchNumber: num++,
                round: roundNumber,
                matchOrder: i,
                teamA: byId[pairs[i][0]],
                teamB: byId[pairs[i][1]]
            });
            created.push(m._id);
        }
        if (byeId) {
            const bye = await this.createByeMatch(tournamentId, stage, null, {
                name: `${stage.name}: R${roundNumber}-Bye`,
                matchNumber: num++,
                round: roundNumber,
                matchOrder: pairs.length,
                teamA: byId[byeId]
            });
            created.push(bye._id);
        }
        return created;
    }

    // ---- STANDINGS (by Stage _id, null-safe for BYE) ----

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
            const done = m.status === 'finished' || m.status === 'bye';
            if (!done || !m.winner) return;
            const winnerId = m.winner.toString();
            if (!stats[winnerId]) return;

            // BYE: one side only, counts as a win without a game
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
