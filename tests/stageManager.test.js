const Match = require('../models/Match');
const Stage = require('../models/Stage');
const Team = require('../models/Team');
const StageEntry = require('../models/StageEntry');
const bracketManager = require('../managers/bracketManager');
const {
    generatePlaceholderMatches,
    resolveStagePlaceholders,
    addTeamToStage,
    swapTeamsInStage
} = require('../managers/stageManager');

jest.mock('../models/Match', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Stage', () => ({ findById: jest.fn() }));
jest.mock('../models/Team', () => ({ findById: jest.fn() }));
jest.mock('../models/StageEntry', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../managers/bracketManager', () => ({
    getStageStandings: jest.fn(),
    createStageEntries: jest.fn(),
    getNextMatchNumber: jest.fn(),
    createMatchDoc: jest.fn()
}));

describe('stageManager', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('addTeamToStage', () => {
        test('rejects a team already in the stage', async () => {
            Stage.findById.mockResolvedValue({ _id: 'st1' });
            StageEntry.findOne.mockResolvedValue({ _id: 'existing' });

            await expect(addTeamToStage('st1', 't1')).rejects.toThrow('Team already in this stage');
            expect(StageEntry.create).not.toHaveBeenCalled();
        });

        test('assigns the next seed after the highest existing seed', async () => {
            Stage.findById.mockResolvedValue({ _id: 'st1' });
            StageEntry.findOne.mockImplementation(q => (q.team
                ? Promise.resolve(null)
                : { sort: () => Promise.resolve({ seed: 4 }) }));
            StageEntry.create.mockImplementation(d => Promise.resolve(d));

            const doc = await addTeamToStage('st1', 't1', 'g1');

            expect(doc.seed).toBe(5);
            expect(doc.group).toBe('g1');
        });

        test('starts at seed 1 when the stage is empty', async () => {
            Stage.findById.mockResolvedValue({ _id: 'st1' });
            StageEntry.findOne.mockImplementation(q => (q.team
                ? Promise.resolve(null)
                : { sort: () => Promise.resolve(null) }));
            StageEntry.create.mockImplementation(d => Promise.resolve(d));

            const doc = await addTeamToStage('st1', 't1');

            expect(doc.seed).toBe(1);
        });
    });

    describe('swapTeamsInStage', () => {
        function setupEntries() {
            const entries = {
                t1: { seed: 1, group: 'gA', save: jest.fn().mockResolvedValue() },
                t2: { seed: 2, group: 'gB', save: jest.fn().mockResolvedValue() }
            };
            StageEntry.findOne.mockImplementation(q => Promise.resolve(entries[q.team]));
            return entries;
        }

        test('blocks the swap when a team has a started or finished match', async () => {
            setupEntries();
            Match.countDocuments.mockResolvedValue(1);

            await expect(swapTeamsInStage('st1', 't1', 't2'))
                .rejects.toThrow('Cannot swap teams with started or finished matches');
        });

        test('swaps seed and group, and updates unplayed match slots', async () => {
            const entries = setupEntries();
            Match.countDocuments.mockResolvedValue(0);
            const match = {
                teamA: 't1', teamARoster: ['old1'],
                teamB: 't3', teamBRoster: ['p3'],
                save: jest.fn().mockResolvedValue()
            };
            Match.find.mockResolvedValue([match]);
            Team.findById.mockImplementation(id => Promise.resolve({ members: id === 't2' ? ['p2'] : [] }));

            const result = await swapTeamsInStage('st1', 't1', 't2');

            expect(entries.t1.seed).toBe(2);
            expect(entries.t1.group).toBe('gB');
            expect(entries.t2.seed).toBe(1);
            expect(entries.t2.group).toBe('gA');
            expect(match.teamA).toBe('t2');
            expect(match.teamARoster).toEqual(['p2']);
            expect(match.teamB).toBe('t3');
            expect(match.teamBRoster).toEqual(['p3']);
            expect(match.save).toHaveBeenCalled();
            expect(result.matchesUpdated).toBe(1);
        });
    });

    describe('resolveStagePlaceholders', () => {
        test('leaves the slot TBD while the source stage has unfinished matches', async () => {
            const match = {
                teamA: null,
                teamAPlaceholder: { sourceStage: 's1', sourceRank: 1, sourceGroupIndex: null },
                teamB: 't2',
                teamBPlaceholder: null,
                save: jest.fn()
            };
            Match.find.mockResolvedValue([match]);
            Match.countDocuments.mockResolvedValue(2);

            const resolved = await resolveStagePlaceholders('tour1', 'st2');

            expect(resolved).toEqual([]);
            expect(match.teamA).toBeNull();
            expect(match.save).not.toHaveBeenCalled();
        });

        test('fills the slot from source standings once the source stage is finished', async () => {
            const match = {
                teamA: null,
                teamAPlaceholder: { sourceStage: 's1', sourceRank: 2, sourceGroupIndex: null },
                teamB: 't2',
                teamBPlaceholder: null,
                save: jest.fn().mockResolvedValue()
            };
            Match.find.mockResolvedValue([match]);
            Match.countDocuments.mockResolvedValue(0);
            bracketManager.getStageStandings.mockResolvedValue([
                { id: 't8', group: 0 },
                { id: 't9', group: 0 }
            ]);
            Team.findById.mockResolvedValue({ members: ['p1'] });

            const resolved = await resolveStagePlaceholders('tour1', 'st2');

            expect(match.teamA).toBe('t9');
            expect(match.teamARoster).toEqual(['p1']);
            expect(match.save).toHaveBeenCalled();
            expect(resolved.length).toBe(1);
        });

        test('filters standings by group when sourceGroupIndex is set', async () => {
            const match = {
                teamA: null,
                teamAPlaceholder: { sourceStage: 's1', sourceRank: 1, sourceGroupIndex: 1 },
                teamB: 't2',
                teamBPlaceholder: null,
                save: jest.fn().mockResolvedValue()
            };
            Match.find.mockResolvedValue([match]);
            Match.countDocuments.mockResolvedValue(0);
            bracketManager.getStageStandings.mockResolvedValue([
                { id: 'tA', group: 0 },
                { id: 'tB', group: 1 }
            ]);
            Team.findById.mockResolvedValue({ members: [] });

            await resolveStagePlaceholders('tour1', 'st2');

            expect(match.teamA).toBe('tB');
        });
    });

    describe('generatePlaceholderMatches', () => {
        test('throws when settings.placeholders is missing', async () => {
            await expect(generatePlaceholderMatches('tour1', { name: 'S', settings: {} }))
                .rejects.toThrow('usePlaceholders requires settings.placeholders');
        });
    });
});
