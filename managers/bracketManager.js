const Match = require('../models/Match');
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');

class BracketManager {
    
    constructor() {
        this.io = null;
        this.onMatchReady = null; // [NEW] Callback for channel creation
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

    // Generate standard seeding order (1 vs N, 2 vs N-1, etc.)
    getSeedingOrder(size) {
        if (size < 2) return [0];
        let rounds = Math.log2(size);
        let seeds = [1, 2];
        
        for (let i = 0; i < rounds - 1; i++) {
            let nextSeeds = [];
            let sum = (Math.pow(2, i + 2)) + 1;
            for (let j = 0; j < seeds.length; j++) {
                nextSeeds.push(seeds[j]);
                nextSeeds.push(sum - seeds[j]);
            }
            seeds = nextSeeds;
        }
        return seeds.map(s => s - 1);
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

                const groupName = (settings.groupNames && settings.groupNames[g]) ? settings.groupNames[g] : `Group ${letters[g] || (g + 1)}`;
                const prefix = `${stageName} ${groupName}`;

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
        // TYPE: ROUND ROBIN (LEAGUE)
        // ==========================================
        else if (type === 'round_robin') {
            const groupCount = settings.groupCount || 1;
            const groups = [];

            if (groupCount > 1) {
                for (let i = 0; i < groupCount; i++) groups[i] = [];
                teams.forEach((team, index) => {
                    groups[index % groupCount].push(team);
                });
            } else {
                groups.push(teams);
            }

            const groupLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

            for (let g = 0; g < groups.length; g++) {
                const groupTeams = groups[g];
                const groupName = (settings.groupNames && settings.groupNames[g]) ? settings.groupNames[g] : (groupCount > 1 ? `Group ${groupLetters[g]}` : '');
                
                let teamPool = [...groupTeams];
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
                                const matchName = groupName ? `${stageName} ${groupName}: Round ${roundNum}` : `${stageName}: Round ${roundNum}`;
                                await createMatch(matchName, realA, realB, roundNum, m);
                            }
                        }
                        rotation.splice(1, 0, rotation.pop());
                    }
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
        // TYPE: CROSS GROUP (Inter-Group Round Robin)
        // ==========================================
        else if (type === 'cross_group') {
            const half = Math.ceil(teams.length / 2);
            const groupA = teams.slice(0, half);
            const groupB = teams.slice(half);
            
            const maxCount = Math.max(groupA.length, groupB.length);
            const paddedA = [...groupA]; while(paddedA.length < maxCount) paddedA.push(null);
            const paddedB = [...groupB]; while(paddedB.length < maxCount) paddedB.push(null);

            for (let r = 0; r < maxCount; r++) {
                for (let i = 0; i < maxCount; i++) {
                    const tA = paddedA[i];
                    const tB = paddedB[(i + r) % maxCount];
                    if (tA && tB) {
                        await createMatch(`${stageName}: Round ${r+1}`, tA, tB, r+1, i);
                    }
                }
            }
        }

        // ==========================================
        // TYPE: DOUBLE ELIMINATION (SPLIT PARTICIPANTS)
        // ==========================================
        else if (type === 'double_elim' && settings.splitParticipants) {
            // --- SPLIT PARTICIPANTS MODE ---
            // Bottom half starts in Losers Bracket
            const paddedTeams = this.padTeams(teams);
            const half = paddedTeams.length / 2;
            const ubTeams = paddedTeams.slice(0, half);
            const lbTeams = paddedTeams.slice(half);

            const ubTotalRounds = Math.log2(ubTeams.length);
            const ubMatches = [];
            const lbMatches = [];

            // 1. Generate Upper Bracket (Half Size)
            for (let r = 1; r <= ubTotalRounds; r++) {
                ubMatches[r] = [];
                const matchCount = ubTeams.length / Math.pow(2, r);
                for (let i = 0; i < matchCount; i++) {
                    const isFinal = (r === ubTotalRounds);
                    const name = isFinal ? `${stageName} UB Final` : `UB R${r}-M${i+1}`;
                    const tA = (r===1) ? ubTeams[i*2] : null;
                    const tB = (r===1) ? ubTeams[i*2+1] : null;
                    ubMatches[r].push(await createMatch(name, tA, tB, r, i, settings.defaultFormat, 'upper'));
                }
            }
            // Link UB
            for (let r = 1; r < ubTotalRounds; r++) {
                for (let i = 0; i < ubMatches[r].length; i++) {
                    await this.linkMatch(ubMatches[r][i], ubMatches[r+1][Math.floor(i/2)], (i%2===0)?'teamA':'teamB');
                }
            }

            // 2. Generate Lower Bracket
            const lbTotalRounds = ubTotalRounds * 2;
            
            // LB Round 1 (Starters)
            lbMatches[1] = [];
            for(let i=0; i<lbTeams.length/2; i++) {
                lbMatches[1].push(await createMatch(`LB R1-M${i+1}`, lbTeams[i*2], lbTeams[i*2+1], 101, i, settings.defaultFormat, 'lower'));
            }

            // LB Round 2 onwards
            let currentLbCount = lbTeams.length / 2;
            for(let r=2; r <= lbTotalRounds; r++) {
                lbMatches[r] = [];
                if (r % 2 !== 0) currentLbCount /= 2; // Odd rounds consolidate
                for(let i=0; i<currentLbCount; i++) {
                    lbMatches[r].push(await createMatch(`LB R${r}-M${i+1}`, null, null, 100+r, i, settings.defaultFormat, 'lower'));
                }
            }

            // Link LB Internal
            for(let r=1; r < lbTotalRounds; r++) {
                const nextR = r + 1;
                if (nextR % 2 === 0) { // R1->R2, R3->R4 (Direct feed to Slot A)
                    for(let i=0; i<lbMatches[r].length; i++) {
                        await this.linkMatch(lbMatches[r][i], lbMatches[nextR][i], 'teamA');
                    }
                } else { // R2->R3, R4->R5 (Consolidate)
                    for(let i=0; i<lbMatches[r].length; i++) {
                        await this.linkMatch(lbMatches[r][i], lbMatches[nextR][Math.floor(i/2)], (i%2===0)?'teamA':'teamB');
                    }
                }
            }

            // Link UB Losers -> LB (Slot B)
            for(let r=1; r <= ubTotalRounds; r++) {
                const ubRound = ubMatches[r];
                const lbTargetRoundIdx = r * 2; // UB R1 -> LB R2, UB R2 -> LB R4
                const lbRound = lbMatches[lbTargetRoundIdx];
                if (lbRound) {
                    for(let i=0; i<ubRound.length; i++) {
                        const targetIndex = (r===1) ? i : (ubRound.length - 1 - i); // Reverse seeding for later rounds
                        const target = lbRound[targetIndex] || lbRound[0];
                        if (target) {
                            ubRound[i].loserMatchId = target._id;
                            ubRound[i].loserMatchSlot = 'teamB';
                            await ubRound[i].save();
                        }
                    }
                }
            }

            // Grand Final
            const ubFinal = ubMatches[ubTotalRounds][0];
            const lbFinal = lbMatches[lbTotalRounds][0];
            const grandFinal = await createMatch(`${stageName} Grand Final`, null, null, 999, 0, settings.finalFormat || 'BO5', 'final');
            await this.linkMatch(ubFinal, grandFinal, 'teamA');
            await this.linkMatch(lbFinal, grandFinal, 'teamB');
        }

        // ==========================================
        // TYPE: SINGLE / DOUBLE ELIMINATION (DEFAULT)
        // ==========================================
        else {
            const groupCount = settings.groupCount || 1;
            const groups = [];

            if (groupCount > 1) {
                let teamsToDist = [...teams];
                for(let i=0; i<groupCount; i++) groups[i] = [];
                teamsToDist.forEach((t, i) => groups[i % groupCount].push(t));
            } else {
                groups.push(teams);
            }
            const groupLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

            for (let g = 0; g < groups.length; g++) {
                const groupTeams = groups[g];
                const groupName = (settings.groupNames && settings.groupNames[g]) ? settings.groupNames[g] : `Group ${groupLetters[g]}`;
                const groupPrefix = groupCount > 1 ? `${stageName} ${groupName}` : stageName;
                
                let paddedTeams = this.padTeams(groupTeams);
                const totalTeams = paddedTeams.length;
                if (totalTeams < 2) continue;

                const seedingOrder = this.getSeedingOrder(totalTeams);
                // Initial Nodes: Array of { type: 'team', data: team } or null (ghost)
                let currentNodes = seedingOrder.map(i => paddedTeams[i] ? { type: 'team', data: paddedTeams[i] } : null);

                const totalRounds = Math.log2(totalTeams);
                const ubDrops = {}; // Map round -> array of drops (match or null)
                
                // Determine rounds to play based on qualifiedCount
                let roundsToPlay = totalRounds;
                if (type === 'single_elim' && settings.qualifiedCount > 1) {
                    const reduction = Math.floor(Math.log2(settings.qualifiedCount));
                    roundsToPlay = Math.max(1, totalRounds - reduction);
                }

                // --- UPPER BRACKET GENERATION ---
                for (let r = 1; r <= roundsToPlay; r++) {
                    const nextNodes = [];
                    const roundDrops = []; 
                    const matchCount = currentNodes.length / 2;

                    for (let i = 0; i < matchCount; i++) {
                        const top = currentNodes[i * 2];
                        const bottom = currentNodes[i * 2 + 1];

                        // Logic: Avoid creating matches for Byes
                        if (!top && !bottom) {
                            nextNodes.push(null);
                            roundDrops.push(null);
                        } else if (top && !bottom) {
                            nextNodes.push(top); // Advance top (Bye)
                            roundDrops.push(null); // No loser
                        } else if (!top && bottom) {
                            nextNodes.push(bottom); // Advance bottom (Bye)
                            roundDrops.push(null); // No loser
                        } else {
                            // Create Real Match
                            const isFinal = (r === totalRounds && settings.qualifiedCount === 1);
                            const matchName = isFinal ? `${groupPrefix} Final` : `${groupPrefix} UB Round ${r} Match ${i + 1}`;
                            const format = isFinal ? (settings.finalFormat || 'BO3') : settings.defaultFormat;
                            
                            const match = await createMatch(matchName, null, null, r, i, format, 'upper');
                            
                            // [FIX] Reset status for Round 1 because createMatch defaults to 'finished' for null vs null
                            if (r === 1) {
                                match.status = 'scheduled';
                                match.note = '';
                            }
                            
                            // [FIX] Reset status for Round 1 because createMatch defaults to 'finished' for null vs null
                            if (r === 1) {
                                match.status = 'scheduled';
                                match.note = '';
                            }
                            
                            // Link Sources
                            if (top.type === 'team') { match.teamA = top.data._id; match.teamARoster = top.data.members; }
                            else if (top.type === 'match') { await this.linkMatch(top.data, match, 'teamA'); }
                            
                            if (bottom.type === 'team') { match.teamB = bottom.data._id; match.teamBRoster = bottom.data.members; }
                            else if (bottom.type === 'match') { await this.linkMatch(bottom.data, match, 'teamB'); }

                            await match.save();
                            nextNodes.push({ type: 'match', data: match });
                            roundDrops.push({ type: 'match', data: match });
                        }
                    }
                    currentNodes = nextNodes;
                    ubDrops[r] = roundDrops;
                }

                // [FEATURE] 3RD PLACE MATCH (Single Elim only)
                if (type === 'single_elim' && settings.hasThirdPlace && settings.qualifiedCount === 1 && totalRounds >= 2) {
                    // Logic requires tracking losers of Semis. 
                    // Since we don't have a simple array of matches, we'd need to look at ubDrops[totalRounds-1] if it exists.
                    // For simplicity in this optimized version, 3rd place is best handled if we have the semi-final matches.
                    const semiDrops = ubDrops[totalRounds - 1];
                    if (semiDrops && semiDrops.length === 2 && semiDrops[0] && semiDrops[1]) {
                        const thirdPlaceMatch = await createMatch(`${groupPrefix} 3rd Place`, null, null, totalRounds, 1, settings.defaultFormat, 'upper');
                        semiDrops[0].data.loserMatchId = thirdPlaceMatch._id; semiDrops[0].data.loserMatchSlot = 'teamA'; await semiDrops[0].data.save();
                        semiDrops[1].data.loserMatchId = thirdPlaceMatch._id; semiDrops[1].data.loserMatchSlot = 'teamB'; await semiDrops[1].data.save();
                    }
                }

                // --- DOUBLE ELIMINATION GENERATION ---
                if (type === 'double_elim') {
                    let lbNodes = []; 
                    
                    // LB Round 1: Pair UB R1 Drops
                    const lbR1Drops = ubDrops[1] || [];
                    for (let i = 0; i < lbR1Drops.length / 2; i++) {
                        const d1 = lbR1Drops[i * 2];
                        const d2 = lbR1Drops[i * 2 + 1];

                        if (d1 && d2) {
                            const match = await createMatch(`${groupPrefix} LB Round 1 Match ${i + 1}`, null, null, 101, i, settings.defaultFormat, 'lower');
                            d1.data.loserMatchId = match._id; d1.data.loserMatchSlot = 'teamA'; await d1.data.save();
                            d2.data.loserMatchId = match._id; d2.data.loserMatchSlot = 'teamB'; await d2.data.save();
                            lbNodes.push({ type: 'match', data: match });
                        } else if (d1) {
                            lbNodes.push({ type: 'loser_ref', data: d1.data }); // Bye
                        } else if (d2) {
                            lbNodes.push({ type: 'loser_ref', data: d2.data }); // Bye
                        } else {
                            lbNodes.push(null);
                        }
                    }

                    let lbRoundNum = 2;
                    for (let r = 2; r <= totalRounds; r++) {
                        // Step 1: Match LB Nodes vs UB Drops (Cross Seeding)
                        const ubRoundDrops = ubDrops[r] || [];
                        const ubDropsReversed = [...ubRoundDrops].reverse();
                        const nextLbNodes = [];

                        for (let i = 0; i < lbNodes.length; i++) {
                            const lbNode = lbNodes[i];
                            const ubDrop = ubDropsReversed[i];

                            if (lbNode && ubDrop) {
                                const match = await createMatch(`${groupPrefix} LB Round ${lbRoundNum} Match ${i + 1}`, null, null, 100 + lbRoundNum, i, settings.defaultFormat, 'lower');
                                
                                if (lbNode.type === 'match') await this.linkMatch(lbNode.data, match, 'teamA');
                                else { lbNode.data.loserMatchId = match._id; lbNode.data.loserMatchSlot = 'teamA'; await lbNode.data.save(); }

                                ubDrop.data.loserMatchId = match._id; ubDrop.data.loserMatchSlot = 'teamB'; await ubDrop.data.save();
                                nextLbNodes.push({ type: 'match', data: match });
                            } else if (lbNode) {
                                nextLbNodes.push(lbNode); // UB Drop was Bye -> Advance
                            } else if (ubDrop) {
                                nextLbNodes.push({ type: 'loser_ref', data: ubDrop.data }); // LB Node was empty -> Drop fills slot
                            } else {
                                nextLbNodes.push(null);
                            }
                        }
                        lbNodes = nextLbNodes;
                        lbRoundNum++;

                        // Step 2: Consolidate LB (Pairing) - Skip if this was the last UB round (LB Final handled by GF link)
                        if (r < totalRounds) {
                            const consolidatedNodes = [];
                            for (let i = 0; i < lbNodes.length / 2; i++) {
                                const top = lbNodes[i * 2];
                                const bottom = lbNodes[i * 2 + 1];
                                
                                if (top && bottom) {
                                    const match = await createMatch(`${groupPrefix} LB Round ${lbRoundNum} Match ${i + 1}`, null, null, 100 + lbRoundNum, i, settings.defaultFormat, 'lower');
                                    
                                    if (top.type === 'match') await this.linkMatch(top.data, match, 'teamA');
                                    else { top.data.loserMatchId = match._id; top.data.loserMatchSlot = 'teamA'; await top.data.save(); }

                                    if (bottom.type === 'match') await this.linkMatch(bottom.data, match, 'teamB');
                                    else { bottom.data.loserMatchId = match._id; bottom.data.loserMatchSlot = 'teamB'; await bottom.data.save(); }

                                    consolidatedNodes.push({ type: 'match', data: match });
                                } else if (top) {
                                    consolidatedNodes.push(top);
                                } else if (bottom) {
                                    consolidatedNodes.push(bottom);
                                } else {
                                    consolidatedNodes.push(null);
                                }
                            }
                            lbNodes = consolidatedNodes;
                            lbRoundNum++;
                        }
                    }

                    // Grand Final
                    if (settings.qualifiedCount === 1) {
                        const ubFinalNode = currentNodes[0];
                        const lbFinalNode = lbNodes[0];
                        
                        if (ubFinalNode && lbFinalNode) {
                            const grandFinal = await createMatch(`${groupPrefix} Grand Final`, null, null, 999, 0, settings.finalFormat || 'BO5', 'final');
                            
                            if (ubFinalNode.type === 'match') await this.linkMatch(ubFinalNode.data, grandFinal, 'teamA');
                            else if (ubFinalNode.type === 'team') { grandFinal.teamA = ubFinalNode.data._id; grandFinal.teamARoster = ubFinalNode.data.members; }

                            if (lbFinalNode.type === 'match') await this.linkMatch(lbFinalNode.data, grandFinal, 'teamB');
                            else if (lbFinalNode.type === 'loser_ref') { lbFinalNode.data.loserMatchId = grandFinal._id; lbFinalNode.data.loserMatchSlot = 'teamB'; await lbFinalNode.data.save(); }
                            
                            await grandFinal.save();
                        }
                    }
                }
            }
        }

        // Process any automatic Bye wins
        for (const match of byeMatchesToProcess) {
            await this.propagateMatchResult(match, match.winner, null);
        }

        return matches;
    }

    // --- UTILITY LINKING FUNCTIONS ----

    async linkMatch(source, target, slot) {
        if(!target) return;
        if(!source) return;
        source.nextMatchId = target._id;
        source.nextMatchSlot = slot;
        await source.save();
    }

    async propagateMatchResult(match, winner, loser) {
        if (!winner) return;
        if (match.nextMatchId) {
            await this.updateMatchSlot(match.nextMatchId, match.nextMatchSlot, winner);
            if(this.io) this.io.emit('notification', { msg: `Bracket: ${winner.shortName} advanced to next round!` });
        }
        if (match.loserMatchId) {
            if (loser) {
                await this.updateMatchSlot(match.loserMatchId, match.loserMatchSlot, loser);
                if(this.io) this.io.emit('notification', { msg: `Bracket: ${loser.shortName} dropped to lower bracket.` });
            } else {
                // [FIX] Handle BYE drop (no loser) - Propagate BYE to lower bracket
                await this.handleByeDrop(match.loserMatchId, match.loserMatchSlot);
            }
        }
    }

    async updateMatchSlot(matchId, slot, team) {
        if (!matchId || !team) return;
        const update = {};
        update[slot] = team._id;
        update[`${slot}Roster`] = team.members;
        
        // Update and return new doc
        const match = await Match.findByIdAndUpdate(matchId, update, { new: true });

        // [NEW] Trigger Channel Creation if both teams are present
        if (match && match.teamA && match.teamB && this.onMatchReady) {
            this.onMatchReady(match);
        }
        
        // [FIX] Check for BYE_DROP condition to auto-advance
        const otherSlot = slot === 'teamA' ? 'teamB' : 'teamA';
        const byeFlag = otherSlot === 'teamA' ? 'BYE_DROP_A' : 'BYE_DROP_B';
        
        if (match && match.note && match.note.includes(byeFlag) && !match.winner) {
             match.winner = team._id;
             match.status = 'finished';
             match.note += " (Auto-Advance)";
             await match.save();
             await this.propagateMatchResult(match, team, null);
             
             await Team.findByIdAndUpdate(team._id, { $inc: { wins: 1 } });
             if (this.io) {
                 this.io.emit('match_update', match);
                 this.io.emit('bracket_update');
             }
        }
    }

    // [FIX] New method to handle BYE drops in Lower Bracket
    async handleByeDrop(matchId, slot) {
        const match = await Match.findById(matchId);
        if (!match) return;

        const flag = slot === 'teamA' ? 'BYE_DROP_A' : 'BYE_DROP_B';
        if (!match.note) match.note = flag;
        else if (!match.note.includes(flag)) match.note += ` ${flag}`;

        // [FIX] Check for Double Bye (Both slots are BYE drops)
        // ถ้าทั้ง 2 ฝั่งเป็น BYE DROP ให้จบแมตช์นี้แล้วส่ง BYE ต่อไปรอบหน้าเลย
        const otherByeFlag = slot === 'teamA' ? 'BYE_DROP_B' : 'BYE_DROP_A';
        if (match.note.includes(otherByeFlag)) {
            match.status = 'finished';
            match.note += " (Double Bye)";
            await match.save();
            
            // Propagate Bye to next match (if any)
            if (match.nextMatchId) {
                await this.handleByeDrop(match.nextMatchId, match.nextMatchSlot);
            }
            return;
        }

        // Check if we can resolve the match now (if other team is already present)
        const otherSlot = slot === 'teamA' ? 'teamB' : 'teamA';
        const otherTeamId = match[otherSlot];

        if (otherTeamId) {
            const wTeam = await Team.findById(otherTeamId);
            if (wTeam) {
                match.winner = wTeam._id;
                match.status = 'finished';
                match.note += " (Auto-Advance)";
                await match.save();
                await this.propagateMatchResult(match, wTeam, null);
                
                await Team.findByIdAndUpdate(wTeam._id, { $inc: { wins: 1 } });
                if (this.io) {
                    this.io.emit('match_update', match);
                    this.io.emit('bracket_update');
                }
            }
        } else {
            await match.save();
        }
    }

    // --- STANDINGS CALCULATION ---
    async getStageStandings(tournamentId, stageIndex) {
        const tournament = await Tournament.findById(tournamentId);
        if (!tournament || !tournament.stages[stageIndex]) return [];

        const stage = tournament.stages[stageIndex];
        const matches = await Match.find({ _id: { $in: stage.matches } });
        const teams = await Team.find({ _id: { $in: stage.stageParticipants } });

        let stats = {};
        stage.stageParticipants.forEach(pid => {
            const team = teams.find(t => t._id.toString() === pid.toString());
            if (team) stats[pid] = { 
                id: pid, name: team.name, shortName: team.shortName, logo: team.logo, 
                wins: 0, losses: 0, played: 0, 
                roundDiff: 0, mapWon: 0, mapLost: 0, mapDiff: 0,
                h2h: {}, group: 'A'
            };
        });

        matches.forEach(m => {
            const gMatch = m.name.match(/Group\s+([A-Z])/);
            const group = gMatch ? gMatch[1] : 'A';
            if (m.teamA && stats[m.teamA.toString()]) stats[m.teamA.toString()].group = group;
            if (m.teamB && stats[m.teamB.toString()]) stats[m.teamB.toString()].group = group;

            if (m.status === 'finished' && m.winner) {
                const winnerId = m.winner.toString();
                const loserId = (m.teamA.toString() === winnerId) ? m.teamB.toString() : m.teamA.toString();

                if (stats[winnerId]) { stats[winnerId].wins++; stats[winnerId].played++; stats[winnerId].h2h[loserId] = 'win'; }
                if (stats[loserId]) { stats[loserId].losses++; stats[loserId].played++; stats[loserId].h2h[winnerId] = 'loss'; }

                let sA = 0, sB = 0, mapsA = 0, mapsB = 0;
                if (m.scores && m.scores.length > 0) {
                    m.scores.forEach(s => {
                        const scA = parseInt(s.teamAScore) || 0; const scB = parseInt(s.teamBScore) || 0;
                        sA += scA; sB += scB;
                        if (scA > scB) mapsA++; else if (scB > scA) mapsB++;
                    });
                    
                    const tA = m.teamA.toString(); const tB = m.teamB.toString();
                    if (stats[tA]) { stats[tA].roundDiff += (sA - sB); stats[tA].mapWon += mapsA; stats[tA].mapLost += mapsB; stats[tA].mapDiff += (mapsA - mapsB); }
                    if (stats[tB]) { stats[tB].roundDiff += (sB - sA); stats[tB].mapWon += mapsB; stats[tB].mapLost += mapsA; stats[tB].mapDiff += (mapsB - mapsA); }
                }
            }
        });

        const tiebreakers = stage.settings?.tiebreakers || ['h2h', 'map_diff', 'round_diff'];

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

    // --- DYNAMIC STAGE MANAGEMENT ---

    async addTeamToStage(tournamentId, stageIndex, teamId, groupIndex = 0) {
        const tournament = await Tournament.findById(tournamentId);
        const stage = tournament.stages[stageIndex];
        const team = await Team.findById(teamId);
        if (!stage || !team) throw new Error("Stage or Team not found");

        // 1. Update Participants List
        if (stage.type === 'cross_group') {
            // Insert based on Alpha/Omega split
            const currentLen = stage.stageParticipants.length;
            const mid = Math.ceil(currentLen / 2);
            if (groupIndex === 0) { // Alpha: Insert at mid (end of Alpha)
                stage.stageParticipants.splice(mid, 0, team._id);
            } else { // Omega: Push to end
                stage.stageParticipants.push(team._id);
            }
        } else {
            stage.stageParticipants.push(team._id);
        }

        // 2. Generate Extra Matches
        const newMatches = [];
        let nextNum = await this.getNextMatchNumber(tournamentId);

        if (stage.type === 'round_robin') {
            // Identify existing teams in the target group
            const groupTeams = new Set();
            const stageMatches = await Match.find({ _id: { $in: stage.matches } });
            
            const groupLetter = String.fromCharCode(65 + groupIndex);
            const groupName = (stage.settings.groupNames && stage.settings.groupNames[groupIndex]) 
                ? stage.settings.groupNames[groupIndex] 
                : (stage.settings.groupCount > 1 ? `Group ${groupLetter}` : '');

            stageMatches.forEach(m => {
                let belongs = !groupName || m.name.includes(groupName); // Simple heuristic
                if (belongs) {
                    if (m.teamA) groupTeams.add(m.teamA.toString());
                    if (m.teamB) groupTeams.add(m.teamB.toString());
                }
            });

            for (const opponentId of groupTeams) {
                if (opponentId === teamId.toString()) continue;
                const m = await this.createMatchForManager(tournamentId, `${stage.name} ${groupName}: Extra`, nextNum++, team, await Team.findById(opponentId), stage.settings.defaultFormat, 99);
                newMatches.push(m._id);
            }
        } else if (stage.type === 'cross_group') {
            const participants = stage.stageParticipants;
            const mid = Math.ceil(participants.length / 2);
            const alpha = participants.slice(0, mid);
            const omega = participants.slice(mid);
            const opponents = (groupIndex === 0) ? omega : alpha;

            for (const oppId of opponents) {
                if (!oppId) continue;
                const m = await this.createMatchForManager(tournamentId, `${stage.name}: Extra`, nextNum++, team, await Team.findById(oppId), stage.settings.defaultFormat, 99);
                newMatches.push(m._id);
            }
        }

        stage.matches.push(...newMatches);
        await tournament.save();
    }

    async swapTeamsInStage(tournamentId, stageIndex, team1Id, team2Id) {
        const tournament = await Tournament.findById(tournamentId);
        const stage = tournament.stages[stageIndex];
        if (!stage) throw new Error("Stage not found");

        // 1. Swap in Participants Array
        const idx1 = stage.stageParticipants.findIndex(id => id.toString() === team1Id);
        const idx2 = stage.stageParticipants.findIndex(id => id.toString() === team2Id);
        if (idx1 !== -1 && idx2 !== -1) {
            stage.stageParticipants.set(idx1, team2Id);
            stage.stageParticipants.set(idx2, team1Id);
            await tournament.save();
        }

        // 2. Swap in Matches
        const matches = await Match.find({ _id: { $in: stage.matches } });
        const t1 = await Team.findById(team1Id);
        const t2 = await Team.findById(team2Id);

        for (const m of matches) {
            let changed = false;
            if (m.teamA && m.teamA.toString() === team1Id) { m.teamA = team2Id; m.teamARoster = t2.members; changed = true; }
            else if (m.teamA && m.teamA.toString() === team2Id) { m.teamA = team1Id; m.teamARoster = t1.members; changed = true; }
            if (m.teamB && m.teamB.toString() === team1Id) { m.teamB = team2Id; m.teamBRoster = t2.members; changed = true; }
            else if (m.teamB && m.teamB.toString() === team2Id) { m.teamB = team1Id; m.teamBRoster = t1.members; changed = true; }
            if (changed) { await m.save(); if (this.io) this.io.emit('match_update', m); }
        }
    }

    async createMatchForManager(tId, name, num, tA, tB, fmt, round) {
        const m = new Match({
            tournament: tId, name, matchNumber: num,
            teamA: tA._id, teamB: tB._id, format: fmt || 'BO1',
            status: 'scheduled', round,
            teamARoster: tA.members, teamBRoster: tB.members
        });
        await m.save();
        return m;
    }
}

module.exports = new BracketManager();