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
// - idempotent ระดับ tournament: ก่อนเขียน tournament ใด จะลบ Stage/Group/StageEntry/TournamentEntry/Registration
//   ที่ผูกกับ tournament นั้นก่อน จึงรันซ้ำหลังล้มกลางทางได้โดยไม่เกิดข้อมูลซ้ำ
// - relationalMigratedAt ถูกตั้งเป็นขั้นตอนสุดท้ายของแต่ละ tournament tournament ที่มี flag แล้วจะถูกข้าม
// - ชื่อ Group ได้จาก regex ชื่อ match เท่านั้น (ข้อมูลเดิมไม่มี group) regex นี้ใช้เฉพาะตอน migrate
// - Registration.team เป็น null เพราะข้อมูลเดิมไม่มี link ไปยัง Team ที่สร้างตอน approve (ต้องจับคู่ด้วย teamName ภายหลัง)
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

// ลบข้อมูลเชิง relational ของ tournament นี้ทั้งหมดก่อนเขียนใหม่ (ทำให้รันซ้ำได้)
async function clearRelational(tid) {
    const oldStageIds = await Stage.find({ tournament: tid }).distinct('_id');
    await StageEntry.deleteMany({ stage: { $in: oldStageIds } });
    await Group.deleteMany({ stage: { $in: oldStageIds } });
    await Stage.deleteMany({ tournament: tid });
    await TournamentEntry.deleteMany({ tournament: tid });
    await Registration.deleteMany({ tournament: tid });
}

async function migrateTournament(db, t) {
    const tid = t._id;

    // ตัด ObjectId ซ้ำออกก่อน เพราะ TournamentEntry มี unique index (tournament, team)
    const participants = [...new Map((t.participants || []).map(p => [String(p), p])).values()];
    const regs = t.pendingRegistrations || [];
    const legacyStages = t.stages || [];

    console.log(`  TournamentEntry: ${participants.length}`);
    console.log(`  Registration: ${regs.length}`);

    if (APPLY) await clearRelational(tid);

    // 1. ทีมใน tournament
    if (APPLY && participants.length) {
        await TournamentEntry.insertMany(participants.map(team => ({
            tournament: tid, team, status: 'registered'
        })));
    }

    // 2. คำขอสมัคร (เก็บ name/role ของสมาชิก และเหตุผลที่ปฏิเสธ)
    if (APPLY && regs.length) {
        await Registration.insertMany(regs.map(r => ({
            tournament: tid,
            team: null,
            teamName: r.teamName,
            contact: [r.contactName, r.contactDiscord].filter(Boolean).join(' / '),
            members: (r.members || []).map(m => ({
                name: m.name || '',
                role: m.role || 'Main',
                riotId: m.riotId || '',
                puuid: ''
            })),
            status: r.status,
            rejectionReason: r.rejectionReason || '',
            reviewedAt: null
        })));
    }

    // 3. stage, group, stage entry และ match
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

    // 4. Stage และ flag migrate เขียนเป็นลำดับท้ายสุดของ tournament นี้
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
