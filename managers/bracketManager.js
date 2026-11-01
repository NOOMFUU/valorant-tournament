const Match = require('../models/Match');
const Stage = require('../models/Stage');
const Group = require('../models/Group');
const StageEntry = require('../models/StageEntry');
const Team = require('../models/Team');

const GROUP_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DONE_STATUSES = ['finished', 'bye', 'auto_forfeit'];

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

    // Link a source match to the target slot. Saves only the source.
    async linkMatch(source, target, slot) {
        if (!source || !target) return;
        source.nextMatchId = target._id;
        source.nextMatchSlot = slot;
        await source.save();
    }

    // Route the loser of `source` into target slot (loser bracket)
    async attachLoser(source, target, slot) {
        source.loserMatchId = target._id;
        source.loserMatchSlot = slot;
        await source.save();
    }

    // Connect a bracket node (match or loser reference) into a target match slot
    async connect(node, target, slot) {
        if (!node) return;
        if (node.type === 'match') await this.linkMatch(node.doc, target, slot);
        else if (node.type === 'loser_ref') await this.attachLoser(node.doc, target, slot);
    }

    // ---- ROUND ROBIN ----

    async generateRoundRobin(tournamentId, stage, list) {
        const cfg = stage.settings || {};
        const groupCount = cfg.groupCount || 1;
        const groups = await this.createGroups(stage, groupCount, cfg.groupNames || []);
        const buckets = groups.map(() => []);
        list.forEach((t, i) => buckets[i % groupCount].push(t));

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

    async generateSwissRound1(tournamentId, stage, list) {
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

    // ---- SINGLE / DOUBLE ELIMINATION (single group, no split) ----

    async generateElimination(tournamentId, stage, list) {
        const cfg = stage.settings || {};
        const isDouble = stage.type === 'double_elim';
        const qualified = cfg.qualifiedCount || 1;
        if ((cfg.groupCount || 1) > 1) throw new Error('Multi-group elimination is a Phase 3 follow-up');
        if (cfg.splitParticipants) throw new Error('Split double elimination is a Phase 3 follow-up');

        const [group] = await this.createGroups(stage, 1, cfg.groupNames || []);
        await this.createStageEntries(stage, list, group);

        const padded = this.padTeams(list);
        const total = padded.length;
        if (total < 2) return [];

        const seeding = this.getSeedingOrder(total);
        let currentNodes = seeding.map(i => padded[i] ? { type: 'team', team: padded[i] } : null);
        const totalRounds = Math.log2(total);

        let roundsToPlay = totalRounds;
        if (!isDouble && qualified > 1) {
            roundsToPlay = Math.max(1, totalRounds - Math.floor(Math.log2(qualified)));
        }

        let num = await this.getNextMatchNumber(tournamentId);
        const created = [];
        const teamOf = n => (n && n.type === 'team') ? n.team : null;
        const mk = async (name, round, order, teamA, teamB, format) => {
            const m = await this.createMatchDoc(tournamentId, stage, group, {
                name, matchNumber: num++, round, matchOrder: order, teamA, teamB, format
            });
            created.push(m._id);
            return m;
        };

        // --- UPPER BRACKET ---
        const ubDrops = {};
        for (let r = 1; r <= roundsToPlay; r++) {
            const next = [];
            const drops = [];
            for (let i = 0; i < currentNodes.length / 2; i++) {
                const top = currentNodes[i * 2];
                const bottom = currentNodes[i * 2 + 1];

                if (!top && !bottom) { next.push(null); drops.push(null); continue; }
                if (!top || !bottom) { next.push(top || bottom); drops.push(null); continue; } // BYE: advance, no loser

                // Only single elimination gets the "Final" name/format here; the double-elim Grand Final is created below.
                const isFinal = (!isDouble && r === totalRounds && qualified === 1);
                const name = isFinal ? `${stage.name} Final` : `${stage.name} UB Round ${r} Match ${i + 1}`;
                const format = isFinal ? (cfg.finalFormat || 'BO3') : cfg.defaultFormat;
                const m = await mk(name, r, i, teamOf(top), teamOf(bottom), format);
                await this.connect(top, m, 'teamA');
                await this.connect(bottom, m, 'teamB');

                next.push({ type: 'match', doc: m });
                drops.push({ type: 'match', doc: m });
            }
            currentNodes = next;
            ubDrops[r] = drops;
        }

        // --- 3RD PLACE (single elim only) ---
        if (!isDouble && cfg.hasThirdPlace && qualified === 1 && totalRounds >= 2) {
            const semi = ubDrops[totalRounds - 1];
            if (semi && semi.length === 2 && semi[0] && semi[1]) {
                const third = await mk(`${stage.name} 3rd Place`, totalRounds, 1, null, null, cfg.defaultFormat);
                await this.attachLoser(semi[0].doc, third, 'teamA');
                await this.attachLoser(semi[1].doc, third, 'teamB');
            }
        }

        if (!isDouble) return created;

        // --- LOWER BRACKET (double elim) ---
        let lbNodes = [];
        const r1 = ubDrops[1] || [];
        for (let i = 0; i < r1.length / 2; i++) {
            const d1 = r1[i * 2];
            const d2 = r1[i * 2 + 1];
            if (d1 && d2) {
                const m = await mk(`${stage.name} LB Round 1 Match ${i + 1}`, 101, i, null, null, cfg.defaultFormat);
                await this.attachLoser(d1.doc, m, 'teamA');
                await this.attachLoser(d2.doc, m, 'teamB');
                lbNodes.push({ type: 'match', doc: m });
            } else if (d1 || d2) {
                lbNodes.push({ type: 'loser_ref', doc: (d1 || d2).doc }); // single loser passes through
            } else {
                lbNodes.push(null);
            }
        }

        let lbRound = 2;
        for (let r = 2; r <= totalRounds; r++) {
            // Step 1: LB survivors vs UB drops (reverse seeding)
            const drops = (ubDrops[r] || []).slice().reverse();
            const next = [];
            for (let i = 0; i < lbNodes.length; i++) {
                const lb = lbNodes[i];
                const ub = drops[i];
                if (lb && ub) {
                    const m = await mk(`${stage.name} LB Round ${lbRound} Match ${i + 1}`, 100 + lbRound, i, null, null, cfg.defaultFormat);
                    await this.connect(lb, m, 'teamA');
                    await this.attachLoser(ub.doc, m, 'teamB');
                    next.push({ type: 'match', doc: m });
                } else if (lb) {
                    next.push(lb);
                } else if (ub) {
                    next.push({ type: 'loser_ref', doc: ub.doc });
                } else {
                    next.push(null);
                }
            }
            lbNodes = next;
            lbRound++;

            // Step 2: consolidate LB pairs (skipped after last UB round)
            if (r < totalRounds) {
                const cons = [];
                for (let i = 0; i < lbNodes.length / 2; i++) {
                    const top = lbNodes[i * 2];
                    const bottom = lbNodes[i * 2 + 1];
                    if (top && bottom) {
                        const m = await mk(`${stage.name} LB Round ${lbRound} Match ${i + 1}`, 100 + lbRound, i, null, null, cfg.defaultFormat);
                        await this.connect(top, m, 'teamA');
                        await this.connect(bottom, m, 'teamB');
                        cons.push({ type: 'match', doc: m });
                    } else {
                        cons.push(top || bottom || null);
                    }
                }
                lbNodes = cons;
                lbRound++;
            }
        }

        // --- GRAND FINAL ---
        const ubFinal = currentNodes[0];
        const lbFinal = lbNodes[0];
        if (qualified === 1 && ubFinal && lbFinal) {
            const gf = await mk(`${stage.name} Grand Final`, 999, 0, teamOf(ubFinal), teamOf(lbFinal), cfg.finalFormat || 'BO5');
            await this.connect(ubFinal, gf, 'teamA');
            await this.connect(lbFinal, gf, 'teamB');
        }

        return created;
    }

    // ---- DISPATCH ----

    async generateStage(tournamentId, stage, teams) {
        const cfg = stage.settings || {};
        if (cfg.usePlaceholders) {
            // Lazy require: stageManager.js requires this module at load time, so a top-level require here would be circular.
            const stageManager = require('./stageManager');
            return stageManager.generatePlaceholderMatches(tournamentId, stage);
        }

        const list = (teams || []).filter(Boolean);
        if (cfg.randomize && stage.type !== 'cross_group') this.shuffle(list);

        switch (stage.type) {
            case 'round_robin': return this.generateRoundRobin(tournamentId, stage, list);
            case 'swiss': return this.generateSwissRound1(tournamentId, stage, list);
            case 'single_elim':
            case 'double_elim': return this.generateElimination(tournamentId, stage, list);
            case 'gsl':
            case 'cross_group':
            case 'triple_elim':
                throw new Error(`${stage.type} is a Phase 3 follow-up`);
            default:
                throw new Error(`Unknown stage type: ${stage.type}`);
        }
    }

    // ---- MATCH RESULT & PROPAGATION ----

    // Record a finished match and push the winner/loser into their downstream slots
    async updateMatch(matchId, { winnerId, scores = [] }) {
        const match = await Match.findById(matchId);
        if (!match) throw new Error('Match not found');
        if (DONE_STATUSES.includes(match.status)) throw new Error('Match already finished');

        const aId = match.teamA ? match.teamA.toString() : null;
        const bId = match.teamB ? match.teamB.toString() : null;
        const winner = winnerId ? winnerId.toString() : null;
        if (!winner || (winner !== aId && winner !== bId)) {
            throw new Error('Winner must be one of the teams in this match');
        }
        const loser = winner === aId ? bId : aId;

        match.scores = scores;
        match.winner = winner;
        match.status = 'finished';
        await match.save();

        await this.propagateMatchResult(match, winner, loser);

        if (this.io) {
            this.io.emit('match_update', match);
            this.io.emit('bracket_update');
        }
        return match;
    }

    // Structural note: bracket generation never creates a match with an empty
    // feeder slot (BYE sources emit no loser, and LB pairs are only built from
    // real feeders), so no BYE-drop flag is needed like the legacy note-based logic.
    async propagateMatchResult(match, winnerId, loserId) {
        if (!winnerId) return;
        if (match.nextMatchId) {
            await this.updateMatchSlot(match.nextMatchId, match.nextMatchSlot, winnerId);
        }
        if (match.loserMatchId && loserId) {
            await this.updateMatchSlot(match.loserMatchId, match.loserMatchSlot, loserId);
        }
    }

    async updateMatchSlot(matchId, slot, teamId) {
        if (!matchId || !teamId || !slot) return null;
        const team = await Team.findById(teamId);
        if (!team) return null;

        const match = await Match.findByIdAndUpdate(
            matchId,
            { [slot]: team._id, [`${slot}Roster`]: team.members },
            { new: true }
        );

        if (match && match.teamA && match.teamB && this.onMatchReady) {
            this.onMatchReady(match);
        }
        if (this.io && match) this.io.emit('match_update', match);
        return match;
    }

    // Manual match creation used by team management (relational version)
    async createMatchForManager(tournamentId, stage, group, data) {
        return this.createMatchDoc(tournamentId, stage, group, {
            name: data.name,
            matchNumber: data.matchNumber,
            round: data.round || 99,
            matchOrder: data.matchOrder || 0,
            teamA: data.teamA,
            teamB: data.teamB,
            format: data.format
        });
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
            const done = DONE_STATUSES.includes(m.status);
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
