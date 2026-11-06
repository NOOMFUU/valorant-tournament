# VALORANT Tournament: UI System v1.0

สถานะ: Draft (รอ review)
อ้างอิง: `design/valorant-tournament-uxui-design.md` (UX/UI spec v1.0, merged แล้ว), `design/valorant-tournament-system-design.md` (v2), `design/valorant-tournament-system-design-appendix-v2.1.md`

เอกสารนี้ครอบคลุม design ทั้งระบบ: design tokens, component, pattern, และ spec รายหน้าสำหรับทุกไฟล์ใน `public/` ที่มีอยู่จริง

---

## 1. ไฟล์ใน design system

| ไฟล์ | หน้าที่ |
|---|---|
| `design/ui-system/tokens.css` | ค่า token: สี, ฟอนต์, spacing, radius, shadow, focus, motion |
| `design/ui-system/components.html` | ตัวอย่าง component ทุกตัวในสถานะต่าง ๆ (เปิดในเบราว์เซอร์ได้) |
| `design/ui-system/README.md` | เอกสารนี้: หลักการ, pattern, spec รายหน้า |

การนำไปใช้: ให้ทุกหน้าใน `public/` โหลด `tokens.css` ก่อน และห้ามใช้ค่าสีหรือขนาดฟอนต์ hard-code นอก token

---

## 2. หลักการ UI

1. **สถานะมาก่อน**: ทุกหน้าต้องบอกสถานะปัจจุบันและ "ขั้นต่อไป" ก่อนรายละเอียดอื่น
2. **เวลาเป็นข้อมูลหลัก**: เวลาแมตช์, check-in, veto timer แสดงชัดและอัปเดต real-time
3. **ไม่รั่วข้อมูล**: หน้า public แสดงเฉพาะข้อมูลที่ serializer อนุญาต (ไม่มี `password`, `vetoData` ระหว่างแข่ง, `scoreSubmission`)
4. **ยืนยันก่อนการกระทำที่ย้อนกลับยาก**: reset, force-winner, ลบทีม/stage ต้องมี modal แสดงผลกระทบ
5. **Discord เป็นส่วนเสริม**: หน้าเว็บต้องทำงานได้แม้ Discord ใช้งานไม่ได้

---

## 3. Layout และ navigation

### 3.1 Shell หลัก (Public)
- Top bar: โลโก้, เมนู (หน้าแรก, ทัวร์นาเมนต์, สมัครทีม, กฎ), ปุ่ม "เข้าสู่ระบบ"
- Mobile (360-767): เมนูเป็น hamburger, drawer จากขวา
- Footer: ลิงก์กฎ, ติดต่อ admin, ลิขสิทธิ์

### 3.2 Shell ทีม (Team dashboard, veto)
- Top bar: ชื่อทีม + logo, badge สถานะทีม, เมนูผู้ใช้ (ออกจากระบบ)
- Mobile: bottom action bar มี 3 ปุ่มหลัก (แมตช์ถัดไป, Roster, การแจ้งเตือน)

### 3.3 Shell Admin
- Sidebar ซ้าย (desktop 1024+ เต็มรูป, tablet 768-1023 เป็น icon, mobile เป็น drawer)
- Header: ค้นหา, ปุ่มแจ้งเตือนงานค้าง, เมนู admin
- Breadcrumb ทุกหน้าลึก

### 3.4 Overlay
- ไม่มี shell, ไม่มี interaction, พื้นหลังโปร่งใส (สำหรับ OBS chroma หรือ browser source)

---

## 4. Pattern หลัก

### 4.1 Match status
| สถานะ | สี token | ข้อความ (TH) | ตัวอย่าง |
|---|---|---|---|
| scheduled | `--status-scheduled` | กำหนดการ | ก่อนเริ่มแมตช์ |
| live | `--status-live` + จุดกระพริบ | กำลังแข่ง | veto/เกมดำเนินอยู่ |
| pending_approval | `--status-pending` | รอยืนยันผล | มีผลส่งแต่ยังไม่ยืนยัน |
| finished | `--status-finished` | จบแล้ว | มีผลสุดท้าย |
| bye | `--status-bye` | ได้สิทธิ์เข้ารอบ (BYE) | ไม่มีคู่แข่ง |
| auto_forfeit | `--status-forfeit` | ชนะโดยไม่แข่ง | ทีมเดียวมา / ไม่มีใครมา |
| disputed | `--status-disputed` | มีข้อพิพาท | รอ admin ตัดสิน |

ข้อความสถานะต้องมีทั้งสีและตัวอักษร (ไม่พึ่งสีอย่างเดียว เพื่อ accessibility)

### 4.2 Countdown
- แสดงรูปแบบ `mm:ss`, ใช้ `--font-mono-num`
- ต่ำกว่า 60 วินาที เปลี่ยนเป็น `--color-warning`, ต่ำกว่า 10 วินาที เปลี่ยนเป็น `--color-primary` และ `aria-live="assertive"`
- ตอนหมดเวลา: แสดงข้อความ "หมดเวลา" และข้อความอธิบายผลลัพธ์ที่เกิดขึ้น

### 4.3 Bracket
- Node แสดงทีม A/B, score, status badge
- ทีมที่ชนะเป็นตัวหนา, ทีมที่แพ้เป็นสีจาง (`--color-text-muted`)
- Hover/focus แสดง highlight เส้นทางของทีมที่เลือก
- Mobile: แสดงเป็นรายการตามรอบ (round list) แทน tree

### 4.4 Table (standings, leaderboard, admin log)
- Sticky header, zebra เฉพาะ desktop
- คอลัมน์ตัวเลขชิดขวา, ใช้ `tabular-nums`
- Mobile: ซ่อนคอลัมน์รอง (ระบุใน spec รายหน้า) และเลื่อนแนวนอนได้

### 4.5 Form
- Label อยู่เหนือ field เสมอ
- Error แสดงใต้ field พร้อมไอคอน, validate ตอน blur และตอน submit
- ปุ่ม submit disabled ขณะส่ง และแสดง spinner
- เก็บ draft ใน localStorage สำหรับฟอร์มสมัครทีม

### 4.6 Modal confirm
- หัวข้อบอกการกระทำ, เนื้อหาบอกผลกระทบ (เช่น "จะย้อน wins/losses ของทีม A 1 ครั้ง และ bracket รอบถัดไป 2 แมตช์")
- ปุ่ม destructive อยู่ขวา สีแดง, ปุ่มยกเลิกเป็น ghost, กด Esc ได้
- Focus trap ภายใน modal

### 4.7 Toast และ inline alert
- Toast: สำเร็จ/ข้อมูล หายใน 5 วินาที, error ไม่หายจนผู้ใช้ปิด
- Inline alert: ใช้สำหรับสถานะที่ผู้ใช้ต้องแก้ไข (เช่น Riot ID ไม่ถูกต้อง)

### 4.8 Empty, loading, error
- Loading: skeleton ตามรูปร่างของเนื้อหาจริง ไม่ใช้ spinner กลางจอ
- Empty: ข้อความอธิบาย + action ถัดไป (เช่น "ยังไม่มีแมตช์ — ดูทัวร์นาเมนต์")
- Error: ข้อความที่เข้าใจได้ + ปุ่ม "ลองอีกครั้ง", ไม่แสดง stack trace หรือ error code ดิบ

### 4.9 Real-time connection
- ตัวบ่งชี้เล็กมุมขวาบน: เขียว = เชื่อมต่อ, เหลือง = กำลัง reconnect, แดง = ออฟไลน์
- ระหว่างออฟไลน์ ปุ่ม action ที่มีผลต่อแมตช์ถูก disable พร้อมข้อความเหตุผล

---

## 5. Spec รายหน้า

แต่ละหน้าระบุ: ผู้ใช้, วัตถุประสงค์, ข้อมูลที่แสดง, การกระทำหลัก, สถานะพิเศษ, และหมายเหตุการ implement (อ้าง API/Socket จาก v2 และ appendix)

### 5.1 `index.html`: หน้าแรก
- **ผู้ใช้**: Visitor
- **วัตถุประสงค์**: ให้เห็นทัวร์นาเมนต์ที่กำลังแข่งและเปิดรับสมัคร
- **ข้อมูล**: hero (ชื่อทัวร์นาเมนต์, สถานะ, ปุ่ม "ดูตาราง" และ "สมัครทีม"), แมตช์ live (สูงสุด 3), แมตช์ถัดไป 5 รายการ, ผลล่าสุด 5 รายการ
- **การกระทำ**: ไปหน้าทัวร์นาเมนต์, สมัครทีม, ดูผล
- **สถานะพิเศษ**: ไม่มีทัวร์นาเมนต์ที่ active แสดง empty state พร้อมลิงก์ไปดูที่เก็บถาวร (`archive.html`)
- **Implement**: `GET /tournaments/:id/public`, `GET /matches/upcoming`

### 5.2 `tournament_view.html`: หน้าทัวร์นาเมนต์ (Public)
- **ผู้ใช้**: Visitor
- **ข้อมูล**: header (ชื่อ, สถานะ, วันที่, prize pool), tabs: Bracket, Schedule, Standings, Leaderboard, Rules
- **การกระทำ**: เปลี่ยน tab, เลือก stage (ถ้ามีหลาย stage), ไปหน้าทีม
- **ไม่แสดง**: veto state, score submission ของแมตช์ที่ยังไม่จบ
- **ความยาว**: ไฟล์ปัจจุบัน 77 KB ต้องแยก component (bracket, leaderboard) เพื่อดูแลง่าย
- **Implement**: `GET /tournaments/:id/public`, `GET /stages/:stageId/standings`, `GET /tournaments/:id/leaderboard`

### 5.3 `schedule.html`: ตารางแข่ง
- **ผู้ใช้**: Visitor, Team member
- **ข้อมูล**: จัดกลุ่มตามวัน, แสดงเวลา (เขตเวลา Asia/Bangkok), คู่แข่ง, สถานะ, ช่องทางดูสด
- **การกระทำ**: กรองตามวัน, กรองตามทีม, เพิ่มลง calendar (ICS)
- **สถานะพิเศษ**: เวลายังไม่กำหนด แสดง "รอกำหนดเวลา"
- **Implement**: `GET /matches/upcoming`

### 5.4 `standings.html`: ตารางคะแนน
- **ผู้ใช้**: Visitor
- **ข้อมูล**: อันดับ, ทีม, W, L, map diff, round diff, ตาราง h2h เมื่อ tie
- **กฎ**: tie-break ตาม v2 ข้อ 7 ต้องมี seed เป็นตัวสุดท้าย แสดงเหตุผลการจัดอันดับในคำอธิบายใต้ตาราง
- **การกระทำ**: เลือก stage, เลือก group (ถ้ามี)
- **Mobile**: ซ่อน round diff, คงอันดับ/ทีม/W-L
- **Implement**: `GET /stages/:stageId/standings`

### 5.5 `rules.html`: กฎการแข่งขัน
- **ผู้ใช้**: Visitor, ทุกบทบาท
- **ข้อมูล**: กฎจาก tournament.rules, mapPool, รูปแบบ BO1/BO3/BO5 ของแต่ละ stage, ขั้นตอน check-in และ forfeit
- **การกระทำ**: เลื่อนไป section ผ่าน table of contents
- **Implement**: `GET /tournaments/:id/public` (field `rules`)

### 5.6 `archive.html`: ทัวร์นาเมนต์ที่จบแล้ว
- **ผู้ใช้**: Visitor
- **ข้อมูล**: การ์ดทัวร์นาเมนต์ (ชื่อ, ปี, แชมป์, runner-up), กรองตามปี
- **การกระทำ**: เปิดหน้าทัวร์นาเมนต์ในโหมดอ่านอย่างเดียว
- **Implement**: `GET /tournaments?isArchived=true` (ต้องยืนยัน query ก่อน implement)

### 5.7 `register.html`: สมัครทีม
- **ผู้ใช้**: Applicant (Captain)
- **วัตถุประสงค์**: ส่ง registration เข้า `Registration` collection
- **ขั้นตอน (3 step)**:
  1. ข้อมูลทีม: ชื่อทีม (unique), ชื่อย่อ, โลโก้ (PNG/JPG/WebP ≤ 2 MB, preview ก่อนส่ง)
  2. ผู้ติดต่อ: ชื่อ, Discord (`contactDiscord`)
  3. สมาชิก 8 คน: 5 Main + 2 Sub + 1 Coach แต่ละคนมี ชื่อ, Riot ID (`ชื่อ#แท็ก`) พร้อมปุ่ม "ตรวจสอบ" ที่เรียก Riot API
- **Invite code**: แสดงเฉพาะเมื่อ `accessType = invite_only`
- **Validation**: inline ตอน blur, ตรวจซ้ำกับ Riot ID ที่ลงทะเบียนแล้ว
- **สถานะหลังส่ง**: หน้ายืนยัน "รอการอนุมัติ" พร้อมรหัสอ้างอิงและเวลาที่ส่ง
- **สถานะพิเศษ**: ปิดรับสมัคร, เต็มแล้ว (แสดงคิวรอ), rate limit (ข้อความ "ลองใหม่ใน X นาที")
- **Implement**: `POST /tournaments/:id/register`, `GET /tournaments/:id/access`

### 5.8 `login.html`: เข้าสู่ระบบ
- **ผู้ใช้**: Team member, Admin
- **ข้อมูล**: username, password, ปุ่มเข้าสู่ระบบ
- **สถานะพิเศษ**: ทีมที่ยัง pending แสดง "ทีมของคุณรอการอนุมัติ", บัญชีที่ถูกระงับ, ครบ rate limit
- **หมายเหตุ**: ไม่บอกว่า username ถูกหรือผิด (ข้อความเดียวกัน) เพื่อกัน user enumeration
- **Implement**: `POST /login`

### 5.9 `team.html`: หน้าทีมสาธารณะ
- **ผู้ใช้**: Visitor
- **ข้อมูล**: โลโก้, ชื่อทีม, W-L, roster (ชื่อ, Riot ID, role), ประวัติแมตช์, สถิติ (ACS, K/D, ADR)
- **ไม่แสดง**: email, Discord ส่วนตัว, ข้อมูล pendingUpdate
- **Implement**: `GET /teams/:id/stats`, ข้อมูลทีมจาก `GET /teams` (ต้องแก้ N1 ก่อน: projection `-password`)

### 5.10 `team-dashboard.html`: แดชบอร์ดทีม
- **ผู้ใช้**: Team member (role Main/Sub/Coach), Captain (เมื่อเพิ่ม `isCaptain`)
- **โครง**: header ทีม, card "แมตช์ถัดไป", card "การแจ้งเตือน", roster, ประวัติแมตช์
- **Card แมตช์ถัดไป**: เวลา, คู่แข่ง, countdown, ปุ่มตามสถานะ
  - ก่อน check-in window: ปุ่ม disabled พร้อมเวลาเปิด
  - ใน window: ปุ่ม "เช็คอิน" (primary)
  - หลัง check-in: "เข้า Veto Lobby" หรือ "รายงานผล"
- **Roster**: ทุกคนมี status (approved / pending), ปุ่มขอแก้ Riot ID แสดงสถานะ pendingUpdate
- **Roster lock**: เมื่อทีมถูกล็อกหลังเริ่มทัวร์นาเมนต์ ปุ่มแก้ไขถูกซ่อนพร้อมคำอธิบาย
- **Implement**: `GET /teams/me`, `PUT /teams/roster`, `GET /notifications` (ต้องมี teamId ใน JWT, N3), `POST /matches/:id/checkin`
- **หมายเหตุ**: ไฟล์ปัจจุบัน 103 KB ต้องแยก component และใช้ token แทนค่า hard-code

### 5.11 `veto.html`: Veto lobby
- **ผู้ใช้**: Team member ของแมตช์ (ผ่าน membership check), Public (ดูได้เฉพาะ state สาธารณะ)
- **Layout (desktop)**: แถบ timer ด้านบน, แผนที่ grid ตรงกลาง, ฝั่งซ้าย/ขวาเป็นทีม A/B พร้อม turn indicator, ด้านล่างเป็น log action
- **Layout (mobile)**: แผนที่เป็น list, action bar ติดด้านล่าง
- **Flow**: coin toss → ban → pick → side (ตาม vetoManager)
- **Timer**: 45 วินาทีต่อ action, ต่ำกว่า 10 วินาทีแสดงคำเตือนและ aria-live assertive, ตอนหมดเวลาแสดงผลการ auto-action ตามที่ตัดสินใจ (รอคำตอบคำถามข้อ 3)
- **Pause**: ปุ่ม "ขอพัก" แสดงจำนวนครั้งที่เหลือ, ปิดตามเงื่อนไข
- **สถานะพิเศษ**: socket หลุด (ดู 4.9), ไม่ใช่สมาชิกแมตช์ (แสดงเฉพาะ state สาธารณะ), แมตช์ยังไม่เริ่ม
- **ต้องลบ**: `setRoomPass()`, `#roomPassContent` (PR #1 / phase 1c)
- **Audio**: ใช้ `vetoAudio.js` แต่ต้องมีปุ่มปิดเสียงและเคารพการตั้งค่าเบราว์เซอร์
- **Implement**: Socket `join_match` (ต้องตรวจ membership), `match_update` (payload ตาม role)

### 5.12 `post_match.html`: หลังแมตช์
- **ผู้ใช้**: Team member ของแมตช์
- **วัตถุประสงค์**: ส่งผลและสถิติผู้เล่น
- **ขั้นตอน**:
  1. เลือกผู้ชนะ และกรอก score ตามรูปแบบ (BO1/BO3/BO5) ฟอร์มปรับตาม format; score ที่ไม่ถูกต้องไม่สามารถส่งได้
  2. กรอกสถิติผู้เล่นต่อแมป (ACS, K, D, A, ADR, HS%) หรือ upload screenshot
  3. ตรวจสอบและส่ง
- **หลังส่ง**: สถานะ "รอทีมตรงข้ามยืนยัน" พร้อมปุ่ม "ยืนยัน" หรือ "โต้แย้ง" สำหรับฝั่งตรงข้าม (ไม่ใช่ทีมที่ส่ง)
- **Dispute**: ต้องระบุเหตุผลและแนบหลักฐานได้
- **Forfeit**: ปุ่ม "แจ้งทีมไม่มา" เปิดหลังเวลาที่กำหนด พร้อม upload หลักฐาน
- **Implement**: `POST /matches/:id/submit-score`, `POST /matches/:id/verify-score`, `POST /matches/:id/dispute-score`, `POST /matches/:id/claim-forfeit`, `POST /matches/:id/stats`

### 5.13 `caster_dashboard.html`: แดชบอร์ดแคสเตอร์
- **ผู้ใช้**: Caster / Streamer (ได้ลิงก์จาก admin)
- **ข้อมูล**: รายการแมตช์ live และที่กำลังจะถึง, ลิงก์ overlay ของแต่ละแมตช์พร้อมปุ่มคัดลอก, สรุป veto state (อ่านอย่างเดียว)
- **การกระทำ**: คัดลอกลิงก์ overlay, เปิด overlay preview
- **ไม่มี**: ปุ่มที่แก้ไขผล (แคสเตอร์เป็น read-only)
- **Implement**: `GET /overlay/match/:id`, Socket `match_update`

### 5.14 `overlay.html`: Overlay สำหรับ OBS
- **ผู้ใช้**: Caster / Stream (ผ่าน browser source)
- **ขนาด**: ออกแบบที่ 1920x1080, ทดสอบที่ 1280x720 ให้ scale ตาม
- **องค์ประกอบ**: ชื่อทีม + โลโก้, series score, map ปัจจุบัน, veto ที่ทำไปแล้ว, ชื่อทัวร์นาเมนต์
- **Theme**: ใช้ token เดียวกับเว็บ มีตัวเลือก high-contrast สำหรับ stream
- **กฎ**: ไม่มี interaction, ไม่แสดงข้อมูลที่ยังไม่ public (ready flags, sequence ที่ยังไม่ยืนยัน), animation fade 300 ms (ปิดตาม reduced-motion)
- **Implement**: `GET /overlay/match/:id` (payload ต้องลดตาม B.5 ใน appendix)

### 5.15 `admin.html`: Admin console
- **ผู้ใช้**: Admin
- **โครง**: sidebar + header (ดู 3.3) ประกอบด้วยหน้าย่อย: Dashboard, Registrations, ทีม, ทัวร์นาเมนต์/stage, แมตช์และผล, Discord, Admin Log, ผู้ดูแลระบบ
- **Dashboard**: "งานที่ต้องทำ" 4 การ์ด (dispute รอตัดสิน, registration รออนุมัติ, forfeit claim, check-in ที่ใกล้หมดเวลา) แต่ละการ์ดคลิกไปหน้าที่เกี่ยวข้อง
- **Registrations**: ตาราง + ปุ่ม approve/reject, approve แสดง credential ครั้งเดียวพร้อมปุ่มคัดลอก (ไม่แสดงซ้ำ, ไม่ log plaintext)
- **แมตช์และผล**: ตารางพร้อมกรองตาม status; แถวที่ disputed ไฮไลต์; ปุ่ม force-winner, manual-score, reset อยู่ใน menu แยกและมี modal confirm (ดู 4.6)
- **Stage**: แสดง bracket แบบ drag-drop ได้เฉพาะ stage ที่ยังไม่เริ่ม
- **Admin Log**: filter (actor, action, matchId, teamId, วันที่), pagination (ปัจจุบันคืน 100 รายการไม่มี paging, ต้องเพิ่ม)
- **Discord**: สถานะ bot และ channel mapping แสดง "ปิดใช้งาน" เมื่อ bot offline
- **การลบ admin**: ปุ่มถูก disable สำหรับตัวเองและ admin คนสุดท้าย พร้อมเหตุผล
- **Implement**: ดู v2 ข้อ 17 และ appendix B.2
- **หมายเหตุ**: ไฟล์ปัจจุบัน 258 KB ควรแยกเป็นหน้าย่อยหรือ module

### 5.16 `public/vetoAudio.js`
ไม่ใช่หน้า แต่เป็น module เสียงของ veto (ดู 5.11)

---

## 6. แผนการ implement UI (ลำดับ)

ลำดับผูกกับ roadmap ใน v2 ข้อ 15 เพื่อไม่ให้ UI เรียก API ที่ยังพัง

| ลำดับ | งาน | ขึ้นกับ |
|---|---|---|
| 1 | โหลด `tokens.css`, แยก component พื้นฐาน (button, badge, card, modal, toast) | - |
| 2 | ลบ room password ออกจาก `veto.html` และหน้าที่เกี่ยวข้อง | Phase 1 (PR #1), 1c |
| 3 | แก้ `GET /teams` และ `GET /teams/me` ไม่คืน password | N1 (Phase 1) |
| 4 | หน้า public: index, tournament_view, schedule, standings, rules, archive, team | Phase 2 |
| 5 | หน้า register และ admin registrations | Phase 2 |
| 6 | Team dashboard, login | Phase 2, N3 (Phase 5) |
| 7 | post_match และ admin match/result | Phase 3 (ResultService) |
| 8 | veto lobby, caster dashboard, overlay | Phase 1b, 5 |
| 9 | Admin console ส่วนที่เหลือ (log, discord, admin users) | Phase 2-6 |

---

## 7. Definition of Done (ระบบ UI)

- [ ] ทุกหน้าใน `public/` ใช้ `tokens.css` และไม่มีสี/ขนาดฟอนต์ hard-code
- [ ] ทุกหน้าที่ดึงข้อมูลมี loading, empty, error, success
- [ ] ทุก action ที่ย้อนกลับยากมี modal confirm พร้อมผลกระทบ
- [ ] Status badge มีข้อความควบคู่สี
- [ ] Contrast WCAG AA (ตรวจด้วยเครื่องมือ) และใช้คีย์บอร์ดได้ครบ
- [ ] ทดสอบ 360, 768, 1024, 1280 px
- [ ] ไม่มีข้อมูลละเอียดรั่วใน public response
- [ ] Overlay ทดสอบใน OBS ที่ 1920x1080 และ 1280x720
