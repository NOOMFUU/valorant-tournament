// scripts/migrate-relational.js
// ย้ายข้อมูล tournament เดิม (stages[], participants[], pendingRegistrations[]) ไปยัง collection แยก
//
// ใช้งาน:
//   node scripts/migrate-relational.js                         # dry-run: แสดงแผนอย่างเดียว ไม่เขียนข้อมูล
//   node scripts/migrate-relational.js --apply                 # เขียนจริง (ฟิลด์เดิมยังอยู่)
//   node scripts/migrate-relational.js --apply --drop-legacy   # เขียนแล้วลบ stages/participants/pendingRegistrations เดิม
//
// env ที่ต้องมี: MONGODB_URI (หรือ MONGO_URI)
//
// หมายเหตุ:
// - ใช้ raw collection เพื่ออ่านข้อมูลเดิมโดยไม่ผ่าน schema ใหม่
// - tournament ที่ migrate แล้วจะถูกทำเครื่องหมาย relationalMigratedAt และข้ามในการรันครั้งถัดไป
// - ถ้า run ล้มเหลวกลางทาง ให้ลบ TournamentEntry/Registration/Group/StageEntry ของ tournament นั้นด้วยตนเองก่อนรันใหม่
// - ชื่อ Group ได้จากชื่อ match เท่านั้น (ข้อมูลเดิมไม่มี group) regex นี้ใช้เฉพาะตอน migrate
// - ห้ามใช้ --drop-legacy จนกว่า routes และ managers จะอ่านจาก collection ใหม่แล้ว

const mongoose = require('mongoose');
const Stage = require('../models/Stage');
const Group = require('../models/Group');
const TournamentEntry = require('../models/TournamentEntry');
const StageEntry = require('../models/StageEntry');
const Registration = require('../models/Registration');

const APPLY = process.argv.includes('--apply');
const DROP_LEGACY = process.argv.includes('--drop-legacy');
const GROUP_RE = /(?:Group|Grp)\s+([A-Z0-9]{1,2})\b/i;
const { ObjectId } = mongoose.Types;

async function migrateTournament(db, t) {
    const tid = t._id;

    // 1. ทีมใน tournament
    const participants = t.participants || [];
    console.log(`  TournamentEntry: ${participants.length}`);
    if (APPLY && participants.length) {
        await TournamentEntry.bulkWrite(participants.map(team => ({
            updateOne: {
                filter: { tournament: tid, team },
                update: { $setOnInsert: { tournament: tid, team, status: 'registered' } },
                upsert: true
            }
        })));
    }

    // 2. คำขอสมัคร
    const regs = t.pendingRegistrations || [];
    console.log(`  Registration: ${regs.length}`);
    if (APPLY && regs.length) {
        await Registration.insertMany(regs.map(r => ({
            tournament: tid,
            team: null, // ข้อมูลเดิมไม่มี link ไปยัง Team ที่สร้างตอน approve
            teamName: r.teamName,
            contact: [r.contactName, r.contactDiscord].filter(Boolean).join(' / '),
            members: (r.members || []).map(m => ({ riotId: m.riotId || '', puuid: '' })),
            status: r.status,
            reviewedAt: null
        })));
    }

    // 3. stage, group, stage entry และ match
    const legacyStages = t.stages || [];
    const stageIds = legacyStages.map(() => new ObjectId());
    const stageDocs = [];

    for (let i = 0; i < legacyStages.length; i++) {
        const s = legacyStages[i];
        const stageId = stageIds[i];
        const matchIds = s.matches || [];

        const matchDocs = await db.collection('matches')
            .find({ _id: { $in: matchIds } }, {
                projection: { name: 1, teamA: 1, teamB: 1, teamAPlaceholder: 1, teamBPlaceholder: 1 }
            })
            .toArray();

        const letterOf = m => (m.name || '').match(GROUP_RE)?.[1]?.toUpperCase() || null;
        const letters = [...new Set(matchDocs.map(letterOf).filter(Boolean))].sort();
        const groupIdByLetter = Object.fromEntries(letters.map(l => [l, new ObjectId()]));
        const groupDocs = letters.map((l, order) => ({
            _id: groupIdByLetter[l], stage: stageId, order, name: `Group ${l}`
        }));

        // group ของทีมมาจาก match แรกที่ทีมนั้นลง
        const teamGroup = {};
        matchDocs.forEach(m => {
            const letter = letterOf(m);
            if (!letter) return;
            [m.teamA, m.teamB].forEach(tm => {
                if (tm && !teamGroup[tm.toString()]) teamGroup[tm.toString()] = groupIdByLetter[letter];
            });
        });

        const entryDocs = (s.stageParticipants || []).map((team, j) => ({
            stage: stageId,
            team,
            group: teamGroup[team.toString()] || null,
            seed: j + 1,
            status: 'active'
        }));

        console.log(`  Stage[${i}] "${s.name}": matches=${matchIds.length}, groups=${letters.length}, entries=${entryDocs.length}`);

        if (APPLY) {
            if (groupDocs.length) await Group.insertMany(groupDocs);
            if (entryDocs.length) await StageEntry.insertMany(entryDocs);

            const ops = matchDocs.map(m => {
                const letter = letterOf(m);
                const $set = {
                    tournament: tid,
                    stage: stageId,
                    group: letter ? groupIdByLetter[letter] : null
                };
                for (const side of ['teamAPlaceholder', 'teamBPlaceholder']) {
                    const ph = m[side];
                    if (ph && typeof ph.sourceStageIndex === 'number' && stageIds[ph.sourceStageIndex]) {
                        $set[`${side}.sourceStage`] = stageIds[ph.sourceStageIndex];
                    }
                }
                return { updateOne: { filter: { _id: m._id }, update: { $set } } };
            });
            if (ops.length) await db.collection('matches').bulkWrite(ops);
        }

        const srcIdx = s.settings?.sourceStageIndex;
        stageDocs.push({
            _id: stageId,
            tournament: tid,
            order: i,
            name: s.name || `Stage ${i + 1}`,
            type: s.type || 'single_elim',
            settings: s.settings || {},
            sourceStage: (typeof srcIdx === 'number' && srcIdx >= 0 && stageIds[srcIdx]) || null,
            status: matchIds.length ? 'active' : 'pending'
        });
    }

    // 4. Stage เขียนเป็นลำดับท้ายสุด และทำเครื่องหมาย migrate แล้วในคำสั่งเดียวกัน
    console.log(`  Stage docs: ${stageDocs.length}`);
    if (APPLY) {
        if (stageDocs.length) await Stage.insertMany(stageDocs);
        const update = { $set: { relationalMigratedAt: new Date() } };
        if (DROP_LEGACY) update.$unset = { stages: '', participants: '', pendingRegistrations: '' };
        await db.collection('tournaments').updateOne({ _id: tid }, update);
    }
}

async function main() {
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('ต้องตั้ง env MONGODB_URI');
        process.exit(1);
    }
    if (DROP_LEGACY && !APPLY) {
        console.error('--drop-legacy ต้องใช้คู่กับ --apply');
        process.exit(1);
    }

    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    console.log(APPLY ? 'MODE: APPLY' : 'MODE: DRY-RUN (ไม่เขียนข้อมูล)');

    const tournaments = await db.collection('tournaments')
        .find({ relationalMigratedAt: { $exists: false } })
        .toArray();
    console.log(`Tournaments to migrate: ${tournaments.length}`);

    for (const t of tournaments) {
        console.log(`Tournament "${t.name}" (${t._id})`);
        await migrateTournament(db, t);
    }

    await mongoose.disconnect();
    console.log('done');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
