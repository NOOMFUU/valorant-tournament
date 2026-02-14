const Match = require('../models/Match');

class BracketManager {
    
    constructor() {
        this.io = null;
    }

    setIO(io) {
        this.io = io;
    }

    // เติมทีมให้ครบจำนวน Power of 2 (เช่น 4, 8, 16, 32) ด้วย null (Bye)
    padTeams(teams) {
        if (!teams || teams.length === 0) return [];
        const count = teams.length;
        const power = Math.pow(2, Math.ceil(Math.log2(count)));
        const padded = [...teams];
        while (padded.length < power) { padded.push(null); }
        return padded;
    }

    // ฟังก์ชันสลับตำแหน่งทีม (Random Seed)
    shuffle(array) {
        let currentIndex = array.length, randomIndex;
        while (currentIndex != 0) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex--;
            [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
        }
        return array;
    }

    // [NEW] ฟังก์ชันหาเลข Match ล่าสุดเพื่อรันเลขต่อ (001 -> 002)
    async getNextMatchNumber(tournamentId) {
        const lastMatch = await Match.findOne({ tournament: tournamentId }).sort({ matchNumber: -1 });
        return (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;
    }

    // --- MAIN GENERATION FUNCTION ---
    async generateStage(tournamentId, stageName, type, teams, settings) {
        if (!teams || teams.length === 0) return [];

        let matches = [];
        const byeMatchesToProcess = [];
        
        // 1. RANDOM SEED LOGIC
        // หากเป็น 'cross_group' (ดึงจาก Stage เก่าแบบไขว้สาย A1 vs B2) ห้าม Random เพื่อรักษาลำดับ
        if (settings.randomize && settings.advanceMethod !== 'cross_group') {
            teams = this.shuffle([...teams]);
        }

        // [NEW] เตรียมตัวนับเลข Match
        let currentMatchNum = await this.getNextMatchNumber(tournamentId);

        // Helper สร้าง Match
        const createMatch = async (name, tA, tB, round, order, format, bracketType = 'upper') => {
            const m = new Match({
                tournament: tournamentId,
                name: name,
                matchNumber: currentMatchNum++, // รันเลข Match ต่อเนื่อง
                teamA: tA ? tA._id : null,
                teamB: tB ? tB._id : null,
                format: format || settings.defaultFormat || 'BO1',
                round: round,
                matchOrder: order,
                vetoData: { status: 'pending' },
                teamARoster: tA ? tA.members : [],
                teamBRoster: tB ? tB.members : []
            });

            // Handle Auto-Win conditions (Byes)
            if (tA && !tB) { m.status = 'finished'; m.winner = m.teamA; m.note = "BYE"; }
            else if (!tA && tB) { m.status = 'finished'; m.winner = m.teamB; m.note = "BYE"; }
            else if (!tA && !tB) { 
                if (round === 1) { m.status = 'finished'; m.note = "EMPTY_BYE"; } 
                else { m.status = 'scheduled'; }
            }

            await m.save();
            matches.push(m._id);
            if (m.note === "BYE" && m.winner) byeMatchesToProcess.push(m);
            return m;
        };

        // ==========================================
        // TYPE: GSL GROUPS (Dual Tournament Format)
        // ==========================================
        if (type === 'gsl') {
            const groupCount = Math.ceil(teams.length / 4);
            const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            
            for(let g = 0; g < groupCount; g++) {
                const groupTeams = teams.slice(g * 4, g * 4 + 4);
                while(groupTeams.length < 4) groupTeams.push(null);

                const prefix = `${stageName} `;

                // Opening Matches (Seed 1 vs 4, Seed 2 vs 3)
                const m1 = await createMatch(`${prefix}: Opening A`, groupTeams[0], groupTeams[3], 1, (g*10)+1);
                const m2 = await createMatch(`${prefix}: Opening B`, groupTeams[1], groupTeams[2], 1, (g*10)+2);

                // Winners Match (Winner M1 vs Winner M2) -> Winner qualifies as Seed #1
                const m3 = await createMatch(`${prefix}: Winners`, null, null, 2, (g*10)+3);
                
                // Elimination Match (Loser M1 vs Loser M2)
                const m4 = await createMatch(`${prefix}: Elimination`, null, null, 2, (g*10)+4);

                // Decider Match (Loser Winners vs Winner Elimination) -> Winner qualifies as Seed #2
                const m5 = await createMatch(`${prefix}: Decider`, null, null, 3, (g*10)+5);

                // Link Logic
                await this.linkMatch(m1, m3, 'teamA'); // Winner M1 -> Winners A
                await this.linkMatch(m2, m3, 'teamB'); // Winner M2 -> Winners B

                m1.loserMatchId = m4._id; m1.loserMatchSlot = 'teamA'; await m1.save(); // Loser M1 -> Elim A
                m2.loserMatchId = m4._id; m2.loserMatchSlot = 'teamB'; await m2.save(); // Loser M2 -> Elim B

                m3.loserMatchId = m5._id; m3.loserMatchSlot = 'teamA'; await m3.save(); // Loser Winners -> Decider A
                await this.linkMatch(m4, m5, 'teamB'); // Winner Elim -> Decider B
            }
        }
        
        // ==========================================
        // TYPE: TRIPLE ELIMINATION
        // ==========================================
        else if (type === 'triple_elim') {
            let paddedTeams = this.padTeams(teams);
            const totalTeams = paddedTeams.length;
            const totalRounds = Math.log2(totalTeams); 

            const ubMatches = [];
            const midMatches = []; 
            const lbMatches = []; 

            // 1. Upper Bracket
            for (let r = 1; r <= totalRounds; r++) {
                ubMatches[r] = [];
                const matchCount = totalTeams / Math.pow(2, r);
                for (let i = 0; i < matchCount; i++) {
                    const match = await createMatch(`UB R${r}-M${i+1}`, (r===1?paddedTeams[i*2]:null), (r===1?paddedTeams[i*2+1]:null), r, i, settings.defaultFormat, 'upper');
                    ubMatches[r].push(match);
                }
            }
            // Link UB Internally
            for (let r = 1; r < totalRounds; r++) {
                for (let i = 0; i < ubMatches[r].length; i++) {
                    await this.linkMatch(ubMatches[r][i], ubMatches[r+1][Math.floor(i/2)], (i%2===0)?'teamA':'teamB');
                }
            }

            // 2. Middle Bracket (Standard Lower Bracket)
            const midTotalRounds = (totalRounds - 1) * 2;
            for(let r=1; r<=midTotalRounds; r++) {
                midMatches[r] = [];
                const count = Math.ceil(totalTeams / Math.pow(2, Math.floor(r/2) + 2)); 
                for(let i=0; i<(count<1?1:count); i++) {
                    midMatches[r].push(await createMatch(`MB R${r}-M${i+1}`, null, null, 100+r, i, settings.defaultFormat, 'middle'));
                }
            }
            // Link UB Losers -> MB (Simplified Mapping)
            for(let r=1; r<totalRounds; r++) {
                const ubRound = ubMatches[r];
                const targetMbRound = r===1 ? 1 : (r-1)*2;
                const mbRound = midMatches[targetMbRound];
                if(mbRound) {
                    for(let i=0; i<ubRound.length; i++) {
                        const m = ubRound[i];
                        let slot = (r===1 && i%2===0) ? 'teamA' : 'teamB';
                        if(r>1) slot = 'teamB'; 
                        const targetM = mbRound[Math.floor(i/(r===1?2:1))] || mbRound[0];
                        if(targetM) {
                            m.loserMatchId = targetM._id; m.loserMatchSlot = slot; await m.save();
                        }
                    }
                }
            }
            // Link MB Internally
             for (let r = 1; r < midTotalRounds; r++) {
                for (let i = 0; i < midMatches[r].length; i++) {
                    const curr = midMatches[r][i];
                    let next, slot;
                    if (r % 2 !== 0) { next = midMatches[r+1][i]; slot = 'teamA'; }
                    else { next = midMatches[r+1][Math.floor(i/2)]; slot = (i%2===0)?'teamA':'teamB'; }
                    if(next) await this.linkMatch(curr, next, slot);
                }
            }

            // 3. Third Bracket (LB) - Optional Last Chance
            const lbTotalRounds = midTotalRounds - 2; 
            if(lbTotalRounds > 0) {
                 for(let r=1; r<=lbTotalRounds; r++) {
                    lbMatches[r] = [];
                    const count = midMatches[r].length / 2; 
                    for(let i=0; i< (count<1?1:count); i++) {
                        lbMatches[r].push(await createMatch(`LB R${r}-M${i+1}`, null, null, 200+r, i, settings.defaultFormat, 'lower'));
                    }
                }
                // Link MB Losers -> LB
                for(let r=1; r<=lbTotalRounds; r++) {
                     for(let i=0; i<midMatches[r].length; i++) {
                         const m = midMatches[r][i];
                         const target = lbMatches[r][Math.floor(i/2)] || lbMatches[0][0]; 
                         if(target) {
                             m.loserMatchId = target._id; m.loserMatchSlot = (i%2===0)?'teamA':'teamB'; await m.save();
                         }
                     }
                }
                // Internal LB Link
                for(let r=1; r<lbTotalRounds; r++) {
                    for(let i=0; i<lbMatches[r].length; i++) {
                        await this.linkMatch(lbMatches[r][i], lbMatches[r+1][Math.floor(i/2)], (i%2===0)?'teamA':'teamB');
                    }
                }
            }

            // Grand Final
             const ubFinal = ubMatches[totalRounds][0];
             const mbFinal = midMatches[midTotalRounds][0];
             const gf = await createMatch(`${stageName} Grand Final`, null, null, 999, 0, settings.finalFormat || 'BO5', 'final');
             await this.linkMatch(ubFinal, gf, 'teamA');
             await this.linkMatch(mbFinal, gf, 'teamB');
        }

        // ==========================================
        // TYPE: ROUND ROBIN (LEAGUE)
        // ==========================================
        else if (type === 'round_robin') {
            let teamPool = [...teams];
            if (teamPool.length % 2 !== 0) teamPool.push(null);
            const numTeams = teamPool.length;
            const roundsPerLeg = numTeams - 1;
            const matchesPerRound = numTeams / 2;

            for (let leg = 0; leg < (settings.roundCount || 1); leg++) {
                let rotation = [...teamPool];
                for (let r = 0; r < roundsPerLeg; r++) {
                    const roundNum = r + 1 + (leg * roundsPerLeg);
                    for (let m = 0; m < matchesPerRound; m++) {
                        const tA = rotation[m];
                        const tB = rotation[numTeams - 1 - m];
                        if (tA && tB) { 
                            const realA = leg % 2 === 0 ? tA : tB;
                            const realB = leg % 2 === 0 ? tB : tA;
                            await createMatch(`${stageName}: Round ${roundNum}`, realA, realB, roundNum, m);
                        }
                    }
                    // Rotate array for next round pairing
                    rotation.splice(1, 0, rotation.pop());
                }
            }
        }

        // ==========================================
        // TYPE: SWISS SYSTEM
        // ==========================================
        else if (type === 'swiss') {
            const matchCount = Math.floor(teams.length / 2);
            for (let i = 0; i < matchCount; i++) {
                // Initial Round (R1)
                await createMatch(`${stageName}: R1-M${i + 1}`, teams[i * 2], teams[i * 2 + 1], 1, i);
            }
            if (teams.length % 2 !== 0) {
                 await createMatch(`${stageName}: R1-Bye`, teams[teams.length-1], null, 1, matchCount);
            }
        }

        // ==========================================
        // TYPE: SINGLE / DOUBLE ELIMINATION (DEFAULT)
        // ==========================================
        else {
            let paddedTeams = this.padTeams(teams);
            const totalTeams = paddedTeams.length;
            if (totalTeams < 2) return [];

            const totalRounds = Math.log2(totalTeams);
            const ubMatches = []; 
            
            // Generate Upper Bracket
            for (let r = 1; r <= totalRounds; r++) {
                ubMatches[r] = [];
                const matchCount = totalTeams / Math.pow(2, r);
                for (let i = 0; i < matchCount; i++) {
                    const isFinal = (r === totalRounds);
                    const matchName = isFinal ? `${stageName} Final` : `UB R${r}-M${i + 1}`;
                    const format = isFinal ? (settings.finalFormat || 'BO3') : settings.defaultFormat;
                    const match = await createMatch(matchName, (r===1?paddedTeams[i*2]:null), (r===1?paddedTeams[i*2+1]:null), r, i, format, 'upper');
                    ubMatches[r].push(match);
                }
            }

            // Link Upper Bracket
            for (let r = 1; r < totalRounds; r++) {
                for (let i = 0; i < ubMatches[r].length; i++) {
                    await this.linkMatch(ubMatches[r][i], ubMatches[r + 1][Math.floor(i / 2)], (i % 2 === 0) ? 'teamA' : 'teamB');
                }
            }

            // [FEATURE] 3RD PLACE MATCH (For Single Elim)
            if (type === 'single_elim' && settings.hasThirdPlace && totalRounds >= 2) {
                const semiMatches = ubMatches[totalRounds - 1];
                if (semiMatches && semiMatches.length === 2) {
                    const thirdPlaceMatch = await createMatch(`${stageName} 3rd Place`, null, null, totalRounds, 1, settings.defaultFormat, 'upper');
                    
                    // Link Losers of Semi-Finals to 3rd Place
                    semiMatches[0].loserMatchId = thirdPlaceMatch._id; semiMatches[0].loserMatchSlot = 'teamA'; await semiMatches[0].save();
                    semiMatches[1].loserMatchId = thirdPlaceMatch._id; semiMatches[1].loserMatchSlot = 'teamB'; await semiMatches[1].save();
                }
            }

            // [FEATURE] DOUBLE ELIMINATION LOGIC
            if (type === 'double_elim') {
                const lbMatches = []; 
                const lbTotalRounds = (totalRounds - 1) * 2;
                
                // Generate Lower Bracket
                for (let r = 1; r <= lbTotalRounds; r++) {
                    lbMatches[r] = [];
                    const powerVal = Math.ceil(r / 2); 
                    const matchCount = totalTeams / Math.pow(2, powerVal + 1);
                    for (let i = 0; i < matchCount; i++) {
                        const match = await createMatch(`LB R${r}-M${i + 1}`, null, null, 100 + r, i, settings.defaultFormat, 'lower');
                        lbMatches[r].push(match);
                    }
                }

                // Link Lower Bracket Internal
                for (let r = 1; r < lbTotalRounds; r++) {
                    for (let i = 0; i < lbMatches[r].length; i++) {
                        const next = (r % 2 !== 0) ? lbMatches[r + 1][i] : lbMatches[r + 1][Math.floor(i / 2)];
                        const slot = (r % 2 !== 0) ? 'teamA' : ((i % 2 === 0) ? 'teamA' : 'teamB');
                        if(next) await this.linkMatch(lbMatches[r][i], next, slot);
                    }
                }

                // Link Drops from Upper to Lower
                for (let r = 1; r < totalRounds; r++) {
                    const ubRoundMatches = ubMatches[r];
                    const targetLbRound = r === 1 ? 1 : (r - 1) * 2;
                    const lbRoundMatches = lbMatches[targetLbRound];

                    if (lbRoundMatches) {
                        for (let i = 0; i < ubRoundMatches.length; i++) {
                            let lbMatch, lbSlot;
                            if (r === 1) {
                                lbMatch = lbRoundMatches[Math.floor(i / 2)];
                                lbSlot = (i % 2 === 0) ? 'teamA' : 'teamB';
                            } else {
                                const reversedIndex = ubRoundMatches.length - 1 - i;
                                lbMatch = lbRoundMatches[reversedIndex]; 
                                lbSlot = 'teamB'; 
                            }
                            if (lbMatch) {
                                ubRoundMatches[i].loserMatchId = lbMatch._id;
                                ubRoundMatches[i].loserMatchSlot = lbSlot;
                                await ubRoundMatches[i].save();
                            }
                        }
                    }
                }

                // Grand Final (Winner UB vs Winner LB)
                const ubFinal = ubMatches[totalRounds][0];
                const lbFinal = lbMatches[lbTotalRounds][0];
                const grandFinal = await createMatch(`${stageName} Grand Final`, null, null, 999, 0, settings.finalFormat || 'BO5', 'final');
                
                await this.linkMatch(ubFinal, grandFinal, 'teamA');
                await this.linkMatch(lbFinal, grandFinal, 'teamB');
                
                // (Optional) Link UB Final Loser to LB Final
                ubFinal.loserMatchId = lbFinal._id; ubFinal.loserMatchSlot = 'teamB'; await ubFinal.save();
            }
        }

        // Process any automatic Bye wins
        for (const match of byeMatchesToProcess) {
            await this.propagateMatchResult(match, match.winner, null);
        }

        return matches;
    }

    // --- UTILITY LINKING FUNCTIONS ---

    async linkMatch(source, target, slot) {
        if(!target) return;
        source.nextMatchId = target._id;
        source.nextMatchSlot = slot;
        await source.save();
    }

    async propagateMatchResult(match, winner, loser) {
        if (!winner) return;
        if (match.nextMatchId) {
            await this.updateMatchSlot(match.nextMatchId, match.nextMatchSlot, winner);
        }
        if (match.loserMatchId && loser) {
            await this.updateMatchSlot(match.loserMatchId, match.loserMatchSlot, loser);
        }
    }

    async updateMatchSlot(matchId, slot, team) {
        if (!matchId || !team) return;
        const update = {};
        update[slot] = team._id;
        update[`${slot}Roster`] = team.members;
        await Match.findByIdAndUpdate(matchId, update, { new: true });
    }
}

module.exports = new BracketManager();