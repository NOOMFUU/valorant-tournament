const bracketManager = require('../managers/bracketManager');
const Match = require('../models/Match');
const Team = require('../models/Team');
const stageManager = require('../managers/stageManager');

jest.mock('../models/Match', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../models/Team', () => ({ findById: jest.fn() }));
jest.mock('../managers/stageManager', () => ({ generatePlaceholderMatches: jest.fn() }));

describe('BracketManager Unit Tests', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('padTeams', () => {
        test('should pad teams to the nearest power of 2', () => {
            const teams = ['Team 1', 'Team 2', 'Team 3'];
            const padded = bracketManager.padTeams(teams);
            expect(padded.length).toBe(4);
            expect(padded[3]).toBe(null);
        });

        test('should return empty array for empty input', () => {
            expect(bracketManager.padTeams([])).toEqual([]);
        });
    });

    describe('shuffle', () => {
        test('should return an array of same length', () => {
            const teams = [1, 2, 3];
            const shuffled = bracketManager.shuffle([...teams]);
            expect(shuffled.length).toBe(3);
            expect(shuffled.sort()).toEqual([1, 2, 3]);
        });
    });

    describe('getSeedingOrder', () => {
        test('should return correct seeding for 4 teams', () => {
            const order = bracketManager.getSeedingOrder(4);
            expect(order).toEqual([0, 3, 1, 2]);
        });
    });

    describe('linkMatch', () => {
        test('should set nextMatchId and nextMatchSlot', async () => {
            const source = { _id: 's1', save: jest.fn() };
            const target = { _id: 't1' };
            await bracketManager.linkMatch(source, target, 'teamA');
            expect(source.nextMatchId).toBe('t1');
            expect(source.nextMatchSlot).toBe('teamA');
            expect(source.save).toHaveBeenCalled();
        });
    });

    describe('updateMatchSlot', () => {
        test('should update match slot and roster', async () => {
            Team.findById.mockResolvedValue({ _id: 'team123', members: ['p1', 'p2'] });
            Match.findByIdAndUpdate.mockResolvedValue({ _id: 'match1', teamA: 'team123' });

            await bracketManager.updateMatchSlot('match1', 'teamA', 'team123');

            expect(Team.findById).toHaveBeenCalledWith('team123');
            expect(Match.findByIdAndUpdate).toHaveBeenCalledWith(
                'match1',
                { teamA: 'team123', teamARoster: ['p1', 'p2'] },
                { new: true }
            );
        });
    });

    describe('propagateMatchResult', () => {
        test('should advance winner to next match', async () => {
            const match = { nextMatchId: 'next1', nextMatchSlot: 'teamB' };
            const winner = { _id: 'w1', shortName: 'Win', members: [] };

            // Mock updateMatchSlot internally used by propagateMatchResult
            const spy = jest.spyOn(bracketManager, 'updateMatchSlot').mockResolvedValue({});

            await bracketManager.propagateMatchResult(match, winner, null);

            expect(spy).toHaveBeenCalledWith('next1', 'teamB', winner);
            spy.mockRestore();
        });

        test('should drop loser to lower bracket', async () => {
            const match = { loserMatchId: 'loser1', loserMatchSlot: 'teamA' };
            const winner = { _id: 'w1' };
            const loser = { _id: 'l1', shortName: 'Lose', members: [] };

            const spy = jest.spyOn(bracketManager, 'updateMatchSlot').mockResolvedValue({});

            await bracketManager.propagateMatchResult(match, winner, loser);

            expect(spy).toHaveBeenCalledWith('loser1', 'teamA', loser);
            spy.mockRestore();
        });
    });

    describe('generateStage', () => {
        test('dispatches usePlaceholders stages to stageManager.generatePlaceholderMatches', async () => {
            stageManager.generatePlaceholderMatches.mockResolvedValue(['m1']);
            const stage = { type: 'round_robin', settings: { usePlaceholders: true } };

            const result = await bracketManager.generateStage('tour1', stage, []);

            expect(stageManager.generatePlaceholderMatches).toHaveBeenCalledWith('tour1', stage);
            expect(result).toEqual(['m1']);
        });
    });
});
