const VetoManager = require('../managers/vetoManager');
const Match = require('../models/Match');

// Mock Match model
jest.mock('../models/Match');

describe('VetoManager Unit Tests', () => {
    let vetoManager;
    let mockIo;

    beforeEach(() => {
        mockIo = {
            to: jest.fn().mockReturnThis(),
            emit: jest.fn()
        };
        vetoManager = new VetoManager(mockIo);
        jest.clearAllMocks();
    });

    describe('handleChat', () => {
        test('should add message to chat and emit event for teamA', async () => {
            const matchId = 'match123';
            const teamId = 'teamA_id';
            const message = 'Hello';
            
            const mockMatch = {
                teamA: { _id: { toString: () => 'teamA_id' }, name: 'Team A' },
                teamB: { _id: { toString: () => 'teamB_id' }, name: 'Team B' },
                chat: [],
                save: jest.fn().mockResolvedValue(true)
            };

            Match.findById.mockReturnValue({
                populate: jest.fn().mockReturnThis(),
                then: jest.fn().mockImplementation(callback => Promise.resolve(callback(mockMatch)))
            });
            
            // Simpler mock for the chain
            Match.findById.mockImplementation(() => ({
                populate: jest.fn().mockReturnThis(),
                then: jest.fn(cb => Promise.resolve(cb(mockMatch)))
            }));
            
            // Wait, previous simple mock was better if I handle the chain
            const mockQuery = {
                populate: jest.fn().mockReturnThis(),
                exec: jest.fn().mockResolvedValue(mockMatch)
            };
            Match.findById.mockReturnValue(mockQuery);
            // Since the code uses await Match.findById(id).populate(...), it returns a Query object which is thenable.
            Match.findById.mockImplementation(() => ({
                populate: jest.fn().mockReturnThis(),
                then: jest.fn(cb => Promise.resolve(cb(mockMatch)))
            }));

            await vetoManager.handleChat(matchId, teamId, message);

            expect(mockMatch.chat.length).toBe(1);
            expect(mockIo.to).toHaveBeenCalledWith(matchId);
        });
    });

    describe('broadcastState', () => {
        test('should emit veto_update with match data', async () => {
            const matchId = 'match123';
            const mockMatch = {
                _id: matchId,
                vetoData: { status: 'pending', mapPool: [] },
                toJSON: jest.fn().mockReturnValue({ _id: matchId, vetoData: { status: 'pending' } }),
                save: jest.fn().mockResolvedValue(true),
                teamA: { _id: 'tA' },
                teamB: { _id: 'tB' }
            };

            Match.findById.mockImplementation(() => ({
                populate: jest.fn().mockReturnThis(),
                then: jest.fn(cb => Promise.resolve(cb(mockMatch)))
            }));

            await vetoManager.broadcastState(matchId);

            expect(mockIo.emit).toHaveBeenCalledWith('veto_update', expect.any(Object));
            expect(mockIo.to).toHaveBeenCalledWith(matchId);
            expect(mockIo.to).toHaveBeenCalledWith('admins');
        });
    });

    describe('handleReady', () => {
        test('should set teamAReady to true and call broadcastState', async () => {
            const matchId = 'match123';
            const teamId = 'teamA_id';
            const mockMatch = {
                _id: matchId,
                roomPassword: 'pass',
                teamA: { _id: { toString: () => 'teamA_id' } },
                teamB: { _id: { toString: () => 'teamB_id' } },
                vetoData: { teamAReady: false, teamBReady: false, status: 'pending' },
                save: jest.fn().mockResolvedValue(true)
            };

            Match.findById.mockImplementation(() => ({
                populate: jest.fn().mockReturnThis(),
                then: jest.fn(cb => Promise.resolve(cb(mockMatch)))
            }));

            // Mock broadcastState to avoid deep nesting
            const broadcastSpy = jest.spyOn(vetoManager, 'broadcastState').mockResolvedValue();
            const coinTossSpy = jest.spyOn(vetoManager, 'startCoinToss').mockResolvedValue();

            await vetoManager.handleReady(matchId, teamId);

            expect(mockMatch.vetoData.teamAReady).toBe(true);
            expect(mockMatch.save).toHaveBeenCalled();
            expect(broadcastSpy).toHaveBeenCalledWith(matchId);
            
            broadcastSpy.mockRestore();
            coinTossSpy.mockRestore();
        });
    });

    describe('logAction', () => {
        test('should add entry to veto history', async () => {
            const mockMatch = {
                vetoData: { history: [] }
            };
            const message = 'Action logged';
            await vetoManager.logAction(mockMatch, message);
            expect(mockMatch.vetoData.history.length).toBe(1);
            expect(mockMatch.vetoData.history[0].text).toBe(message);
        });
    });
});
