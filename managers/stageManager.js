const Match = require('../models/Match');
const Stage = require('../models/Stage');
const Team = require('../models/Team');
const StageEntry = require('../models/StageEntry');
const bracketManager = require('./bracketManager');

const DONE_STATUSES = ['finished', 'bye', 'auto_forfeit'];
const LOCKED_STATUSES = ['live', 'pending_approval', 'finished', 'bye', 'auto_forfeit'];

// Build one slot from a spec: either a known team ({ teamId }) or a placeholder ({ sourceStage, sourceRank, sourceGroupIndex, label }).
async function buildSlot(side) {
    if (!side) return { team: null, placeholder: null };
    if (side.teamId) {
        const team = await Team.findById(side.teamId);
        if (!team) throw new Error(`Team not found: ${side.teamId}`);
        return { team, placeholder: null };
    }
    if (!side.sourceStage) throw new Error('Slot needs either teamId or sourceStage');
    const src = await Stage.findById(side.sourceStage);
    if (!src) throw new Error(`Source stage not found: ${side.sourceStage}`);
    return {
        team: null,
        placeholder: {
            label: side.label || '',
            sourceStage: src._id,
            sourceRank: side.sourceRank || 1,
            sourceGroupIndex: (side.sourceGroupIndex === undefined) ? null : side.sourceGroupIndex
        }
    };
}

// Create TBD matches from stage.settings.placeholders = [{ round, matchOrder, name, format, teamA, teamB }].
// Known teams are registered as StageEntry; placeholder slots are resolved later by resolveStagePlaceholders.
async function generatePlaceholderMatches(tournamentId, stage) {
    const specs = (stage.settings && stage.settings.placeholders) || [];
    if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('usePlaceholders requires settings.placeholders');
    }

    const knownTeams = new Map();
    const built = [];
    for (const spec of specs) {
        const a = await buildSlot(spec.teamA);
        const b = await buildSlot(spec.teamB);
        [a.team, b.team].forEach(t => { if (t) knownTeams.set(t._id.toString(), t); });
        built.push({ spec, a, b });
    }

    if (knownTeams.size > 0) {
        await bracketManager.createStageEntries(stage, [...knownTeams.values()], null);
    }

    let num = await bracketManager.getNextMatchNumber(tournamentId);
    const created = [];
    for (let i = 0; i < built.length; i++) {
        const { spec, a, b } = built[i];
        const m = await bracketManager.createMatchDoc(tournamentId, stage, null, {
            name: spec.name || `${stage.name}: TBD ${i + 1}`,
            matchNumber: num++,
            round: spec.round || 1,
            matchOrder: (spec.matchOrder !== undefined && spec.matchOrder !== null) ? spec.matchOrder : i,
            teamA: a.team,
            teamB: b.team,
            format: spec.format
        });
        if (a.placeholder) m.teamAPlaceholder = a.placeholder;
        if (b.placeholder) m.teamBPlaceholder = b.placeholder;
        if (a.placeholder || b.placeholder) await m.save();
        created.push(m._id);
    }
    return created;
}

// Fill TBD slots whose source stage has finished, using Stage/StageEntry rankings.
async function resolveStagePlaceholders(tournamentId, stageId) {
    const pending = await Match.find({
        tournament: tournamentId,
        $or: [{ teamA: null, 'teamAPlaceholder.sourceStage': { $ne: null } },
              { teamB: null, 'teamBPlaceholder.sourceStage': { $ne: null } }]
    });

    const resolved = [];
    const standingsCache = {};

    for (const match of pending) {
        let changed = false;
        for (const side of ['A', 'B']) {
            const teamKey = 'team' + side;
            const phKey = 'team' + side + 'Placeholder';
            const ph = match[phKey];
            if (match[teamKey] || !ph || !ph.sourceStage) continue;

            const srcId = ph.sourceStage.toString();
            const unfinished = await Match.countDocuments({
                stage: srcId,
                status: { $nin: DONE_STATUSES }
            });
            if (unfinished > 0) continue; // source stage not finished yet

            if (!standingsCache[srcId]) {
                standingsCache[srcId] = await bracketManager.getStageStandings(srcId);
            }
            let pool = standingsCache[srcId];
            if (ph.sourceGroupIndex !== undefined && ph.sourceGroupIndex !== null) {
                pool = pool.filter(s => s.group === ph.sourceGroupIndex);
            }
            const picked = pool[(ph.sourceRank || 1) - 1];
            if (!picked) continue;

            match[teamKey] = picked.id;
            const team = await Team.findById(picked.id);
            match[side === 'A' ? 'teamARoster' : 'teamBRoster'] = team ? team.members : [];
            changed = true;
        }
        if (changed) {
            await match.save();
            resolved.push(match._id);
        }
    }
    return resolved;
}

// Add a team to a stage (optionally into a group) at the next seed position.
async function addTeamToStage(stageId, teamId, groupId = null) {
    const stage = await Stage.findById(stageId);
    if (!stage) throw new Error('Stage not found');

    const exists = await StageEntry.findOne({ stage: stageId, team: teamId });
    if (exists) throw new Error('Team already in this stage');

    const last = await StageEntry.findOne({ stage: stageId }).sort({ seed: -1 });
    const nextSeed = last && last.seed ? last.seed + 1 : 1;

    return StageEntry.create({
        stage: stageId,
        team: teamId,
        group: groupId,
        seed: nextSeed
    });
}

// Swap two teams' seed and group within a stage. Only allowed while neither team has a locked match.
async function swapTeamsInStage(stageId, teamIdA, teamIdB) {
    const [entryA, entryB] = await Promise.all([
        StageEntry.findOne({ stage: stageId, team: teamIdA }),
        StageEntry.findOne({ stage: stageId, team: teamIdB })
    ]);
    if (!entryA || !entryB) throw new Error('Both teams must be in the stage');

    const locked = await Match.countDocuments({
        stage: stageId,
        $or: [{ teamA: { $in: [teamIdA, teamIdB] } }, { teamB: { $in: [teamIdA, teamIdB] } }],
        status: { $in: LOCKED_STATUSES }
    });
    if (locked > 0) throw new Error('Cannot swap teams with started or finished matches');

    const [seedA, groupA] = [entryA.seed, entryA.group];
    entryA.seed = entryB.seed;
    entryA.group = entryB.group;
    entryB.seed = seedA;
    entryB.group = groupA;
    await Promise.all([entryA.save(), entryB.save()]);

    // Swap slots in unplayed matches so the bracket follows the new positions.
    // Rosters follow their team: the slot's roster is reloaded from the team that now occupies it.
    const matches = await Match.find({
        stage: stageId,
        status: 'scheduled',
        $or: [{ teamA: { $in: [teamIdA, teamIdB] } }, { teamB: { $in: [teamIdA, teamIdB] } }]
    });
    const swap = id => (id && id.toString() === teamIdA.toString()) ? teamIdB
        : (id && id.toString() === teamIdB.toString()) ? teamIdA : id;
    for (const m of matches) {
        for (const side of ['A', 'B']) {
            const key = 'team' + side;
            const newId = swap(m[key]);
            if (newId && (!m[key] || newId.toString() !== m[key].toString())) {
                const team = await Team.findById(newId);
                m[key] = newId;
                m[`team${side}Roster`] = team ? team.members : [];
            }
        }
        await m.save();
    }
    return { swapped: [teamIdA, teamIdB], matchesUpdated: matches.length };
}

module.exports = { generatePlaceholderMatches, resolveStagePlaceholders, addTeamToStage, swapTeamsInStage };
