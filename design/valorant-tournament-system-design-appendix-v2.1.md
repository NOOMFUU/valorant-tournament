# VALORANT Tournament Platform: Appendix v2.1 (อ่านโค้ดเพิ่มเติม และแก้ข้อมูลใน v2)

อ้างอิง commit `3c0b11e` บน `main`. เอกสารนี้ต่อท้ายและแก้ข้อมูลบางจุดของ `valorant-tournament-system-design.md` (v2) โดยไม่ต้องแก้ไฟล์ v2 ทั้งฉบับ

---

## A. การแก้ไขข้อมูลใน v2

| ข้อ v2 | ข้อมูลเดิม | ข้อมูลที่ถูกต้องจากการอ่านโค้ด |
|---|---|---|
| 13 Security: Team auth | "JWT role team ไม่เช็ค DB" | ไม่ถูกต้อง. `middleware/auth.js` ดึง `Team` จาก DB ทุก request และคืน 403 ถ้า `status !== 'approved'` |
| 4.4 Team member | ระบุ `riotId`, `puuid`, `discordId`, `isCaptain` | โค้ดจริงใช้ `name`, `tag` (Riot ID แยกเป็นชื่อ+แท็ก), `discordName`, `discordId`, `role` (`Main`/`Sub`/`Coach`), `status`, `puuid`, `accountLevel`, `playerCard`, `pendingUpdate` ยังไม่มี `isCaptain` |
| 2 Registration fix | "`MemberSchema` ไม่มี `riotId`" | ใช้ `tag` แทน ต้องตรวจว่า `Registration.members` ใช้ชื่อ field เดียวกันหรือไม่ |
| 10 Veto | "ตาม SKILL" | ไม่ใช้อ้างอิง SKILL/GEMINI แล้ว (ถูกลบจาก `main`) |
| 16 #14 | Admin log env ไม่ตรงกัน | ยืนยันแล้ว: `logToAdminChannel` ใช้ `DISCORD_ADMIN_LOGS_CHANNEL_ID` แต่ `setupDiscordChannels` เซ็ต `DISCORD_ADMIN_LOG_CHANNEL_ID` |
| 14 Discord persist | ระบุว่า `process.env` หายตอน restart | ยืนยันแล้วที่ `services/discordService.js` (`ensureChannel` เขียน `process.env[envVarName]`) |

---

## B. ฟังก์ชันที่อ่านเพิ่ม (แทนหัวข้อ 17.5 และ 17.6 ของ v2)

สถานะ: **มี** = ใช้งานได้ตามโค้ด, **มีปัญหา** = ทำงานได้แต่มี bug/ช่องโหว่ที่ระบุ, **พัง** = จะ error

### B.1 Team (`routes/teamRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| Login (admin/team) | `POST /login` | มี. rate limit 100 ครั้ง/15 นาที. Team ที่ยัง pending ได้ 403 |
| สมัครทีม | `POST /register` | มี. logo upload, status `pending` |
| รายการทีม | `GET /teams` | **มีปัญหา (ช่องโหว่)**: `Team.find()` ไม่ใช้ projection ทำให้ `password` (bcrypt hash) รั่วสู่ public |
| ข้อมูลทีมตัวเอง | `GET /teams/me` | **มีปัญหา**: คืน `password` hash ด้วย |
| อนุมัติ / ลบทีม | `POST /teams/:id/approve`, `DELETE /teams/:id` | มี (admin). ลบทีมไม่ลบ match/entry ที่อ้างอิง |
| Reset stats ทั้งหมด | `POST /teams/reset-stats` | มี. ไม่ย้อน bracket |
| Import CSV ทีม | `POST /teams/import` | มี. ตั้ง `members` 5 Main, 2 Sub, 1 Coach. parse ด้วย `split(',')` ไม่รองรับ quote |
| อัปเดต roster | `PUT /teams/roster` | มี. ต้อง >=5 คน, เรียก `verifyRiotAccount` (Riot API) ทุกคนที่เปลี่ยนชื่อหรือไม่มี puuid. ถ้า `rosterLocked` = false จะ auto-approve ทุกคน |
| อัปโหลด logo ทีม | `PUT /teams/logo` (team), `PUT /teams/:id/logo` (admin) | มี |
| สร้างทีม (admin) | `POST /teams` | มี. สร้างเป็น `approved` ทันที |
| แก้ทีม | `PUT /teams/:id` | มี. แก้ `wins`/`losses` ตรงได้ (log เฉพาะเมื่อแก้สองค่านี้) |
| รีเซ็ตรหัสทีม | `PUT /teams/:id/reset-password` | มี. แจ้งรหัสใหม่ใน request/response ตามโค้ด |
| อนุมัติ/ปฏิเสธสมาชิก | `PUT /teams/:id/members/:mid/status` | มี. ใช้ `pendingUpdate.name` (ไม่มี `tag` ใน logic นี้) |
| แก้สมาชิก | `PUT /teams/:id/members/:mid/edit` | มี. ไม่ log |
| ลบสมาชิก | `DELETE /teams/:id/members/:mid` | มี |

### B.2 Admin (`routes/adminRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| รายชื่อ admin | `GET /admin/users` | มี (exclude password) |
| สร้าง admin | `POST /admin/users` | มี |
| ลบ admin | `DELETE /admin/users/:id` | มี. กันลบตัวเองและ admin คนสุดท้าย |
| Admin log | `GET /admin/logs` | มี. คืน 100 รายการล่าสุด ไม่มี pagination |
| Broadcast | `POST /admin/broadcast` | มี. ใช้ `createNotification` globalRole `all`. ตัวแปร `io` ไม่ได้ใช้ (dead code) |

### B.3 Discord (`routes/discordRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| Import Discord ID จาก CSV | `POST /admin/discord/import` | **มีปัญหา**: ใช้ `new RegExp(teamName)` จาก input โดยไม่ escape (regex injection) |
| Sync role ทุกทีม | `POST /admin/discord/sync-all-roles` | มี. ไม่มี reconcile; ทำซ้ำกับ `discordService.ensureTeamRole` |
| Sync role ทีมเดียว | `POST /teams/:id/discord/sync-role` | มี. ถ้า `guild` เป็น null จะ error ที่ `guild.roles` (ไม่ได้ check) |
| ปุ่ม claim role | `POST /admin/discord/send-claim` | มี. ใช้ `DISCORD_CLAIM_CHANNEL_ID` |

หมายเหตุ: ปุ่ม `claim_role` ถูก handle ที่ bot (`discordBot.js` ยังไม่ได้อ่าน)

### B.4 Stats (`routes/statsRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| ส่งสถิติผู้เล่นต่อแมป | `POST /matches/:id/stats` (team) | มี. เช็คว่าทีมอยู่ในแมตช์ (membership ครบ). upsert ต่อ player+map |
| สถิติแมตช์ | `GET /matches/:id/stats` | มี (public) |
| สถิติทีม | `GET /teams/:id/stats` | มี (public) |
| Leaderboard | `GET /tournaments/:id/leaderboard` | มี (public). top 50 ตาม ACS |

### B.5 Overlay (`routes/overlayRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| ข้อมูล overlay ของแมตช์ | `GET /overlay/match/:id` (public) | มี. คำนวณ series score และ current map เองฝั่ง route (ควรย้ายไป service). ส่ง `presence` จาก `vetoMgr` และ `vetoData` ทั้งหมด (รวม `sequence`, `ready` flags) |

### B.6 Notification (`routes/notificationRoutes.js`)
| Function | Route | สถานะ |
|---|---|---|
| รายการแจ้งเตือน | `GET /notifications` | **มีปัญหา**: ฝั่งทีมใช้ `req.user.teamId` แต่ JWT ของทีมมีแค่ `id` (`role`, `name`) จึงได้เฉพาะ `globalRole: all` ไม่ได้ของทีมตัวเอง |
| อ่านแล้ว | `PUT /notifications/:id/read` | **มีปัญหาเดียวกัน**: ไม่เช็คว่า notification เป็นของผู้ใช้ (ใครก็ mark ได้ถ้ารู้ id) |
| อ่านทั้งหมด | `PUT /notifications/read/all` | **มีปัญหาเดียวกัน** (ใช้ `teamId` ที่ไม่มี) |

### B.7 Middleware
| ไฟล์ | สรุป | ปัญหา |
|---|---|---|
| `middleware/auth.js` | verify JWT, เช็ค Team status ใน DB ทุก request, role check | ไม่มี membership ต่อ match (ตามที่ระบุไว้แล้ว) |
| `middleware/manageAuth.js` (`checkTournamentAccess`) | เช็คว่า user เป็น `owner` หรืออยู่ใน `collaborators` ของ Tournament | **ไม่ bypass admin**: admin ที่ไม่ใช่ owner จะได้ 403 ทั้งที่มี role admin (ขัดกับ comment ในโค้ด). ยังไม่ได้ตรวจว่า Tournament model มี field `owner`/`collaborators` และ route ไหนใช้ middleware นี้ |
| `middleware/upload.js` | multer: Cloudinary / imgbb / local disk. ตั้งชื่อไฟล์ตามทีม/แมตช์ | ตรวจชนิดไฟล์จาก `file.mimetype` (ค่าที่ client ส่งมา) ไม่ใช่ magic bytes. ไม่มี `.gif`/`.webp` |
| `middleware/validate.js` | ตรวจด้วย schema (`parseAsync`) คืน 400 `{success:false,msg,errors}` | response รูปแบบต่างจาก route อื่นที่คืน `{msg}` (ดู Error contract ใน v2 ข้อ 14) |

### B.8 Services (Agenda และ Discord)
**`services/queueService.js`** (Agenda, `processEvery` 30 วินาที)
| Job | เวลา | หน้าที่ | ปัญหา |
|---|---|---|---|
| `match-reminder-1h` | -60 นาที | แจ้ง Discord | ไม่ส่งถ้า discordChannelId ว่าง |
| `match-notification` | -10 นาที | แจ้ง + ปุ่ม check-in, ตั้ง `notificationSent` | ไม่มีตัวอ่าน `notificationSent` ในโค้ดที่อ่าน |
| `match-reminder-5m` | -5 นาที | เตือนถ้ายังไม่ check-in | - |
| `match-reminder-late` | +3, +6, +9, +12 นาที | เตือนสาย (`15 - minute` คือเวลาที่เหลือ) | ข้อความ "15 mins" hard-code ขัดกับ config check-in ที่อยากรวมศูนย์ (ข้อ 9 ของ v2) |
| `check-in-expiry` | +15 นาที | ตัดสินผลอัตโนมัติ: ทีมเดียวมา = ชนะ, ไม่มีใครมา = double forfeit | **พัง ในกรณี double forfeit**: หลัง `match.winner = null` โค้ดเรียก `match.winner.toString()` ซึ่งจะ TypeError ก่อนถึง propagate. ตัวนี้เขียน `Team.wins/losses` ตรงโดยไม่ผ่าน ResultService และใช้ `match.name += " (Auto Win)"` (ขัดหลัก flag ใน v2 ข้อ 8). ใช้ `require('../server').getIO()` (circular require) |

**`services/discordService.js`**
| Function | หน้าที่ | ปัญหา |
|---|---|---|
| `withRetry` | retry exponential 3 ครั้ง (ไม่ retry error 10003, 10011, 50001) | ดีอยู่แล้ว |
| `logToAdminChannel` | ส่ง admin log | ใช้ env ชื่อ `..._LOGS_...` (ดูข้อ A) |
| `createMatchChannel` / `processChannelQueue` | คิวสร้างห้อง ทีละ 1 วินาที | คิวอยู่ในหน่วยความจำ ถ้า restart หาย |
| `createMatchChannelInternal` | สร้าง role (ถ้าไม่มี), category, text, voice 2 ห้อง, ปุ่ม check-in | ถ้า role ไม่ถูกสร้าง จะ return เงียบ ๆ ไม่มี log |
| `updateMatchTime` | แก้ข้อความ "Scheduled for" | ดึง 50 ข้อความล่าสุด (ไม่ robust) |
| `deleteMatchChannels` / `deleteMatchVoiceChannels` | ลบห้องแมตช์, เปลี่ยนชื่อ category เป็น `[Finished]` | `deleteMatchVoiceChannels` ไม่ได้ลบ category ตามที่ชื่ออาจสื่อ |
| `sendMatchResultToDiscord` | embed ผลแมตช์ + ส่ง results channel | ถ้า `match.teamA` ไม่ populate จะ error |
| `sendBracketAnnouncement` | ประกาศ bracket | - |
| `sendVetoResultToDiscord` | ประกาศผล veto | ใช้ `match.vetoData.pickedMaps` โดยตรง |
| `setupDiscordChannels` | สร้าง/หา channel ตั้งต้น 3 ห้อง แล้วเซ็ต `process.env` | หายตอน restart (ดู v2 ข้อ 11) |

### B.9 ที่ยังไม่ได้อ่าน
- `services/discordBot.js` (ปุ่ม `claim_role`, `checkin_*`)
- `managers/vetoManager.js` รายละเอียด
- `utils/helpers.js`, `utils/schemas.js`, `utils/riotApi.js`, `utils/redis.js`
- `public/`, `scripts/`, `tests/`, `server.js` (ยกเว้นจุดที่ v2 อ้าง)

---

## C. Bug และช่องโหว่ใหม่ที่พบรอบนี้ (เรียงตามความรุนแรง)

| # | ปัญหา | ที่อยู่ | ความรุนแรง |
|---|---|---|---|
| N1 | `GET /teams` และ `GET /teams/me` คืน `password` hash | `teamRoutes.js` | สูงมาก (ความลับรั่ว) |
| N2 | `check-in-expiry` double forfeit เรียก `match.winner.toString()` ตอน `winner = null` | `queueService.js` | สูง (job พัง, ไม่ propagate) |
| N3 | Notification ฝั่งทีมใช้ `req.user.teamId` ที่ไม่มีใน JWT | `notificationRoutes.js` | กลาง |
| N4 | `PUT /notifications/:id/read` ไม่เช็คเจ้าของ | `notificationRoutes.js` | กลาง |
| N5 | Discord import ใช้ RegExp จาก input โดยไม่ escape | `discordRoutes.js` | กลาง |
| N6 | `checkTournamentAccess` ไม่ bypass admin | `manageAuth.js` | กลาง |
| N7 | `check-in-expiry` เขียน wins/losses ตรง ไม่ผ่าน ResultService และ propagate ไม่ idempotent | `queueService.js` | กลาง |
| N8 | Upload ตรวจ mimetype จาก client เท่านั้น | `upload.js` | ต่ำถึงกลาง |
| N9 | `/teams/:id/discord/sync-role` ไม่เช็ค guild null | `discordRoutes.js` | ต่ำ |
| N10 | Queue ของ channel creation อยู่ในหน่วยความจำ หายตอน restart | `discordService.js` | ต่ำ |

---

## D. การเปลี่ยนแปลงต่อ Roadmap (เพิ่มจาก v2 ข้อ 15)

| Phase | งานที่เพิ่ม |
|---|---|
| 1 | เพิ่ม: แก้ N1 (projection `-password` ทุก route ที่ส่ง Team) ทันที ไม่ต้องรอ Phase 2 |
| 3 | เพิ่ม: แก้ N2, N7 ผ่าน ResultService (ใช้ logic เดียวกับ verify/approve) |
| 5 | เพิ่ม: แก้ N3, N4 โดยเปลี่ยน JWT ให้มี `teamId` (หรือเก็บ `id` เป็น teamId ชัดเจน) และเช็คเจ้าของก่อน mark read |
| 6 | เพิ่ม: แก้ N5 (escape regex) และ N9, N10 |
| - | N6: ตัดสินใจว่า admin จะ bypass `checkTournamentAccess` หรือไม่ (ดูคำถามข้อ 8 ด้านล่าง) |

---

## E. คำถามที่ยังค้าง (ตอบแล้วจะอัปเดตเอกสาร)

1. Check-in: 30 นาทีก่อน / ปิด 15 นาทีหลัง (server) หรือปรับ dashboard ให้ตรง
2. TournamentEntry: ทีมที่แข่งจริงจนกว่า admin เอาออก หรือให้ stage กำหนดเอง
3. Auto-action เมื่อหมดเวลา veto: random หรือ skip
4. Riot ID ที่เปลี่ยน: admin อนุมัติทุกครั้ง หรือให้ auto ถ้า API ยืนยันแล้ว
5. Captain: `isCaptain` ใน member หรือยังใช้ role `Main`
6. Multi-instance: ไม่ทำ / ทำ (ต้องใส่ Redis ก่อน Phase 5)
7. Phase 3 formats: อยู่ใน scope นี้หรือไม่
8. Admin bypass `checkTournamentAccess` (N6): ใช่ / ไม่ใช่
