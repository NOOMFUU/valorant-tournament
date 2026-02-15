const Match = require('../models/Match');

// Fallback Map Pool (กรณี Tournament ไม่ได้ตั้งค่าไว้)
const FALLBACK_MAP_POOL = ['Abyss', 'Ascent', 'Bind', 'Haven', 'Lotus', 'Sunset', 'Pearl'];

class VetoManager {
    constructor(io) {
        this.io = io;
        this.timers = {}; 
        this.presence = {};
    }

    async broadcastState(matchId) {
        try {
            const match = await Match.findById(matchId)
                .populate('teamA', 'name shortName logo members') 
                .populate('teamB', 'name shortName logo members')
                .populate('vetoData.pickedMaps.pickedBy', 'name')
                .populate('vetoData.coinTossWinner', 'name')
                .populate('tournament'); 
            
            if(match) {
                // [UPDATED] Force Sync Map Pool ถ้ายังไม่เริ่ม Veto
                // เพื่อให้มั่นใจว่าถ้า Admin เปลี่ยน Map Pool ใน Tournament แมตช์จะอัปเดตตาม
                if (match.vetoData.status === 'pending') {
                    const tournamentPool = (match.tournament && match.tournament.mapPool && match.tournament.mapPool.length > 0) 
                        ? match.tournament.mapPool 
                        : null;

                    // ถ้ามี Pool ใน Tournament และยังไม่ตรงกับใน Match ให้ทับเลย
                    if (tournamentPool) {
                        // เช็คว่าต้องอัปเดตไหม (ป้องกันการเขียน DB ซ้ำๆ โดยไม่จำเป็น)
                        const isDifferent = JSON.stringify(match.vetoData.mapPool) !== JSON.stringify(tournamentPool);
                        if (isDifferent || match.vetoData.mapPool.length === 0) {
                            match.vetoData.mapPool = tournamentPool;
                            await match.save();
                        }
                    } else if (!match.vetoData.mapPool || match.vetoData.mapPool.length === 0) {
                        // ถ้าไม่มีให้ใช้ Fallback
                        match.vetoData.mapPool = FALLBACK_MAP_POOL;
                        await match.save();
                    }
                }

                const matchData = match.toJSON();
                matchData.presence = this.presence[matchId] || {};
                this.io.to(matchId).emit('veto_update', matchData);
                this.io.to('admins').emit('veto_update', matchData);
            }
        } catch (err) { console.error(err); }
    }

    async logAction(match, message) {
        if (!match.vetoData.history) match.vetoData.history = [];
        match.vetoData.history.push({ text: message, timestamp: new Date() });
    }

    // --- CHAT & READY ---
    async handleChat(matchId, teamId, message) {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if(!match) return;
        
        let senderName = "Unknown";
        if (teamId === 'admin') senderName = "ADMIN";
        else if (match.teamA && match.teamA._id.toString() === teamId) senderName = match.teamA.name;
        else if (match.teamB && match.teamB._id.toString() === teamId) senderName = match.teamB.name;

        match.chat.push({ sender: senderName, senderId: teamId, message: message });
        await match.save();
        this.io.to(matchId).emit('chat_new', { sender: senderName, message, senderId: teamId });
    }

    async handleSetRoomPass(matchId, teamId, password) {
        const match = await Match.findById(matchId).populate('teamA');
        if (!match || match.teamA._id.toString() !== teamId) return;
        match.roomPassword = password;
        await this.logAction(match, `HOST: Room Code Updated`);
        await match.save();
        await this.broadcastState(matchId);
        this.io.to(matchId).emit('notification', { msg: `Room Password Updated!` });
    }

    async handleReady(matchId, teamId) {
        const match = await Match.findById(matchId).populate('teamA teamB tournament');
        if (!match || !match.roomPassword) return;

        if (match.teamA._id.toString() === teamId) match.vetoData.teamAReady = true;
        else if (match.teamB._id.toString() === teamId) match.vetoData.teamBReady = true;

        await match.save();
        await this.broadcastState(matchId);

        if (match.vetoData.teamAReady && match.vetoData.teamBReady && match.vetoData.status === 'pending') {
            await this.startCoinToss(match);
        }
    }

    // --- CORE VETO FLOW ---
    async startCoinToss(match) {
        // [UPDATED] Initialize Pool before starting (Final Sync)
        if (match.tournament && match.tournament.mapPool && match.tournament.mapPool.length > 0) {
             match.vetoData.mapPool = match.tournament.mapPool;
        } else if (!match.vetoData.mapPool || match.vetoData.mapPool.length === 0) {
             match.vetoData.mapPool = FALLBACK_MAP_POOL;
        }

        match.vetoData.status = 'coin_toss';
        await this.logAction(match, `System: Coin Toss in progress...`);
        await match.save();
        await this.broadcastState(match._id.toString());

        setTimeout(async () => {
            const m = await Match.findById(match._id).populate('teamA teamB tournament');
            if(!m) return;
            
            const winner = Math.random() < 0.5 ? m.teamA : m.teamB;
            m.vetoData.coinTossWinner = winner;
            m.vetoData.status = 'decision';
            
            await this.startTimerLogic(m, 60); 
            
            await this.logAction(m, `COIN TOSS: ${winner.name} Wins!`);
            await m.save();
            await this.broadcastState(m._id.toString());
        }, 3500); 
    }

    async handleDecision(matchId, teamId, choice) {
        const match = await Match.findById(matchId).populate('teamA teamB');
        if (match.vetoData.status !== 'decision' || match.vetoData.coinTossWinner.toString() !== teamId) return;

        match.vetoData.decisionChoice = choice;
        const winnerId = match.vetoData.coinTossWinner.toString();
        const loserId = (match.teamA._id.toString() === winnerId) ? match.teamB._id.toString() : match.teamA._id.toString();
        const t1 = (choice === 'first') ? winnerId : loserId;
        const t2 = (choice === 'first') ? loserId : winnerId;

        // Define Sequence
        let seq = [];
        if (match.format === 'BO3') {
            seq = [
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'pick', team: t1 }, { act: 'side', team: t2 },
                { act: 'pick', team: t2 }, { act: 'side', team: t1 },
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'decider', team: null }
            ];
        } else if (match.format === 'BO5') {
            seq = [
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'pick', team: t1 }, { act: 'side', team: t2 },
                { act: 'pick', team: t2 }, { act: 'side', team: t1 },
                { act: 'pick', team: t1 }, { act: 'side', team: t2 },
                { act: 'pick', team: t2 }, { act: 'side', team: t1 },
                { act: 'decider', team: null }
            ];
        } else { // BO1
            seq = [
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'ban', team: t1 }, { act: 'ban', team: t2 },
                { act: 'decider', team: null }
            ];
        }

        match.vetoData.sequence = seq;
        match.vetoData.sequenceIndex = 0;
        match.vetoData.status = 'in_progress';
        
        await this.logAction(match, `DECISION: Winner chose to PICK ${choice.toUpperCase()}`);
        await this.startTimerLogic(match, match.vetoData.turnTimeLimit || 45);
        await match.save();
        await this.broadcastState(matchId);
    }

    async handleAction(matchId, teamId, action, map, side) {
        const match = await Match.findById(matchId).populate('teamA teamB');
        const v = match.vetoData;
        if (v.status !== 'in_progress') return;
        
        const step = v.sequence[v.sequenceIndex];
        if (step.team !== teamId) return; 

        const teamName = match.teamA._id.toString() === teamId ? match.teamA.name : match.teamB.name;

        if (action === 'ban') {
            if (v.bannedMaps.includes(map) || v.pickedMaps.some(p => p.map === map)) return;
            v.bannedMaps.push(map);
            await this.logAction(match, `BAN: ${teamName} banned ${map}`);
        } else if (action === 'pick') {
            if (v.bannedMaps.includes(map) || v.pickedMaps.some(p => p.map === map)) return;
            v.pickedMaps.push({ map: map, pickedBy: teamId, sidePicker: null, selectedSide: null });
            await this.logAction(match, `PICK: ${teamName} picked ${map}`);
        } else if (action === 'side') {
            const target = v.pickedMaps.find(m => !m.selectedSide && (m.sidePicker ? m.sidePicker.toString() === teamId : true));
            if (target) {
                target.sidePicker = teamId;
                target.selectedSide = side;
                const isA = teamId === match.teamA._id.toString();
                target.teamAStartingSide = (side === 'atk' ? (isA ? 'atk':'def') : (isA ? 'def':'atk'));
                target.teamBStartingSide = (side === 'atk' ? (isA ? 'def':'atk') : (isA ? 'atk':'def'));
                await this.logAction(match, `SIDE: ${teamName} chose ${side.toUpperCase()}`);
            }
        }

        await this.nextTurn(match);
    }

    async nextTurn(match) {
        match.vetoData.sequenceIndex++;
        
        if (match.vetoData.sequenceIndex >= match.vetoData.sequence.length) {
            match.vetoData.status = 'completed';
            match.status = 'live'; 
            this.clearTimer(match._id);
            await this.logAction(match, `VETO COMPLETED - GLHF!`);
        } else {
            const nextStep = match.vetoData.sequence[match.vetoData.sequenceIndex];
            
            if (nextStep.act === 'decider') {
                const used = [...match.vetoData.bannedMaps, ...match.vetoData.pickedMaps.map(m=>m.map)];
                // [UPDATED] Use current mapPool
                const pool = match.vetoData.mapPool && match.vetoData.mapPool.length > 0 ? match.vetoData.mapPool : FALLBACK_MAP_POOL;
                const available = pool.filter(m => !used.includes(m));
                
                if (available.length > 0) {
                    const mapName = available[0];
                    await this.logAction(match, `DECIDER: ${mapName} was left over`);
                    
                    match.vetoData.pickedMaps.push({
                        map: mapName, pickedBy: null, sidePicker: match.vetoData.coinTossWinner, selectedSide: null
                    });
                    
                    match.vetoData.sequence.splice(match.vetoData.sequenceIndex + 1, 0, {
                        act: 'side', team: match.vetoData.coinTossWinner.toString()
                    });
                }
                match.vetoData.sequenceIndex++;
                await this.startTimerLogic(match, 60);
            } else {
                await this.startTimerLogic(match, match.vetoData.turnTimeLimit || 45);
            }
        }

        await match.save();
        await this.broadcastState(match._id.toString());
    }

    async startTimerLogic(match, durationSeconds) {
        this.clearTimer(match._id);
        
        match.vetoData.currentTurnStartTime = new Date();
        match.vetoData.currentTurnDeadline = new Date(Date.now() + (durationSeconds * 1000));
        
        const matchId = match._id.toString();
        this.timers[matchId] = setTimeout(async () => {
            await this.handleTimeout(matchId);
        }, durationSeconds * 1000);
    }

    clearTimer(matchId) {
        if (this.timers[matchId]) {
            clearTimeout(this.timers[matchId]);
            delete this.timers[matchId];
        }
    }

    async pauseTimer(match) {
        const matchId = match._id.toString();
        if (this.timers[matchId]) {
            clearTimeout(this.timers[matchId]);
            delete this.timers[matchId];
        }
        
        if (match.vetoData.currentTurnDeadline) {
            const now = new Date();
            const deadline = new Date(match.vetoData.currentTurnDeadline);
            const remaining = deadline.getTime() - now.getTime();
            match.vetoData.pausedRemainingTime = Math.max(0, remaining);
            await match.save();
        }
    }

    async resumeTimer(match) {
        const remaining = match.vetoData.pausedRemainingTime || 0;
        if (remaining > 0) {
            await this.startTimerLogic(match, remaining / 1000);
        } else {
            await this.handleTimeout(match._id.toString());
        }
        match.vetoData.pausedRemainingTime = 0;
        await match.save();
        await this.broadcastState(match._id.toString());
    }

    async handleTeamPause(matchId, teamId) {
        const match = await Match.findById(matchId);
        if (!match || match.vetoData.status !== 'in_progress') return { success: false, msg: 'Cannot pause now' };
        
        const isTeamA = match.teamA.toString() === teamId;
        const isTeamB = match.teamB.toString() === teamId;
        if (!isTeamA && !isTeamB) return { success: false, msg: 'Unauthorized' };

        const MAX_PAUSES = 3;
        const currentPauses = isTeamA ? (match.vetoData.teamAPauses || 0) : (match.vetoData.teamBPauses || 0);

        if (currentPauses >= MAX_PAUSES) return { success: false, msg: `Pause limit reached (${MAX_PAUSES}/${MAX_PAUSES})` };

        if (isTeamA) match.vetoData.teamAPauses = currentPauses + 1;
        else match.vetoData.teamBPauses = currentPauses + 1;

        await this.pauseTimer(match);
        
        match.vetoData.status = 'paused';
        match.vetoData.pausedBy = teamId;
        match.vetoData.pauseStartTime = new Date();
        
        await this.logAction(match, `PAUSE: Requested by ${isTeamA ? 'Team A' : 'Team B'} (${currentPauses + 1}/${MAX_PAUSES})`);
        await match.save();
        await this.broadcastState(matchId);
        return { success: true };
    }

    async adminPause(match) {
        await this.pauseTimer(match);
        match.vetoData.status = 'paused';
        match.vetoData.pausedBy = null; // Admin
        match.vetoData.pauseStartTime = new Date();
        await this.logAction(match, `PAUSE: Admin paused veto`);
        await match.save();
        await this.broadcastState(match._id.toString());
    }

    async resetTurnTimer(match) {
        if (match.vetoData.status !== 'in_progress' && match.vetoData.status !== 'decision') return;
        
        let duration = match.vetoData.turnTimeLimit || 45;
        
        if (match.vetoData.status === 'decision') {
            duration = 60;
        } else if (match.vetoData.status === 'in_progress') {
            const step = match.vetoData.sequence[match.vetoData.sequenceIndex];
            if (step && step.act === 'decider') duration = 60;
        }

        await this.logAction(match, `ADMIN: Timer Reset`);
        await this.startTimerLogic(match, duration);
        await match.save();
        await this.broadcastState(match._id.toString());
    }

    async handleTeamResume(matchId, teamId) {
        const match = await Match.findById(matchId);
        if (!match || match.vetoData.status !== 'paused') return { success: false, msg: 'Not paused' };

        const PAUSE_LIMIT_MS = 120 * 1000; // 2 minutes
        const elapsed = Date.now() - new Date(match.vetoData.pauseStartTime).getTime();
        const isPauser = match.vetoData.pausedBy && match.vetoData.pausedBy.toString() === teamId;
        
        if (!isPauser && elapsed < PAUSE_LIMIT_MS) {
            const remaining = Math.ceil((PAUSE_LIMIT_MS - elapsed) / 1000);
            return { success: false, msg: `Opponent pause active. Wait ${remaining}s` };
        }

        match.vetoData.status = 'in_progress';
        match.vetoData.pausedBy = null;
        match.vetoData.pauseStartTime = null;
        
        await this.resumeTimer(match);
        await this.logAction(match, `RESUME: Match continued`);
        return { success: true };
    }

    async handleTimeout(matchId) {
        const match = await Match.findById(matchId);
        if(!match || match.vetoData.status !== 'in_progress') return;
        
        const v = match.vetoData;
        const step = v.sequence[v.sequenceIndex];
        
        // Use stored mapPool or fallback
        const pool = match.vetoData.mapPool && match.vetoData.mapPool.length > 0 ? match.vetoData.mapPool : FALLBACK_MAP_POOL;
        const used = [...v.bannedMaps, ...v.pickedMaps.map(m=>m.map)];
        const available = pool.filter(m => !used.includes(m));
        
        if (step.act === 'ban' || step.act === 'pick') {
             if(available.length > 0) {
                 const randMap = available[Math.floor(Math.random() * available.length)];
                 await this.logAction(match, `TIMEOUT: Auto-${step.act} ${randMap}`);
                 await this.handleAction(matchId, step.team, step.act, randMap);
             }
        } else if (step.act === 'side') {
             const randSide = Math.random() < 0.5 ? 'atk' : 'def';
             await this.logAction(match, `TIMEOUT: Auto-side ${randSide}`);
             await this.handleAction(matchId, step.team, 'side', null, randSide);
        }
    }

    handleConnection(matchId, teamId) {
        if (!this.presence[matchId]) this.presence[matchId] = {};
        if (!this.presence[matchId][teamId]) this.presence[matchId][teamId] = { count: 0, isAway: false };
        this.presence[matchId][teamId].count++;
        this.broadcastState(matchId);
    }

    handleDisconnection(matchId, teamId) {
        if (this.presence[matchId] && this.presence[matchId][teamId]) {
            this.presence[matchId][teamId].count--;
            if (this.presence[matchId][teamId].count <= 0) delete this.presence[matchId][teamId];
            this.broadcastState(matchId);
        }
    }

    handleStatusUpdate(matchId, teamId, status) {
        if (this.presence[matchId] && this.presence[matchId][teamId]) {
            this.presence[matchId][teamId].isAway = (status === 'away');
            this.broadcastState(matchId);
        }
    }

    async restoreTimers() {
        try {
            // หาแมตช์ที่สถานะกำลังแข่ง (in_progress) หรือ decision
            const activeMatches = await Match.find({ 
                'vetoData.status': { $in: ['in_progress', 'decision'] } 
            });

            console.log(`🔄 Restoring Veto Timers for ${activeMatches.length} matches...`);

            for (const match of activeMatches) {
                if (match.vetoData.currentTurnDeadline) {
                    const now = new Date();
                    const deadline = new Date(match.vetoData.currentTurnDeadline);
                    const remainingTime = deadline - now;

                    if (remainingTime > 0) {
                        // ถ้าเวลายังเหลือ ให้ตั้ง Timer ต่อ
                        console.log(`  -> Match ${match._id}: Resuming timer (${Math.ceil(remainingTime/1000)}s)`);
                        this.clearTimer(match._id.toString());
                        this.timers[match._id.toString()] = setTimeout(async () => {
                            await this.handleTimeout(match._id.toString());
                        }, remainingTime);
                    } else {
                        // ถ้าเวลาหมดไปตอน Server ดับ -> สั่งให้ Timeout ทันที
                        console.log(`  -> Match ${match._id}: Expired while offline. Triggering timeout.`);
                        await this.handleTimeout(match._id.toString());
                    }
                }
            }
        } catch (e) {
            console.error("Veto Restore Error:", e);
        }
    }
}

module.exports = VetoManager;