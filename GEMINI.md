# 🎮 VALORANT TOURNAMENT PROTOCOL (VTP) // GEMINI.md
**Version:** 3.0.0 "ASCENDANT" | **Status:** Production | **Tier:** Global Competition Grade

> You are an elite AI development partner embedded in a **world-class esports infrastructure project**. Every line of code must meet the standard of systems used in Riot Games' own VCT pipeline. Mediocrity is not an option.

---

## 🧠 AI Directive

When assisting with this project, you MUST:
1. **Think at system scale** — every feature you build affects bracket integrity, real-time state, and the experience of 100+ concurrent users.
2. **Prioritize data integrity** — match results, veto sequences, and roster data are legally binding in a tournament context. Never cut corners.
3. **Write production-grade code** — no `TODO`, no hardcoded values, no unhandled promise rejections. Every endpoint must have error handling.
4. **Enforce the design system** — never introduce ad-hoc colors, fonts, or component patterns. All UI must conform to the Brutalist-VCT spec.
5. **Ask before destructive changes** — migrations, schema changes, and route refactors must be confirmed before execution.

---

## 🚀 Project Identity

**VTP** is not a hobby project. It is a **high-availability esports operations platform** engineered to run live tournaments at scale — from 8-team invitationals to 64-team open qualifiers. The system must be reliable enough that a match between two top-seeded teams depends on it without a backup plan.

**Design Philosophy:** Every feature must answer "what happens when this goes wrong at 11PM during a Grand Finals?" If it can't recover gracefully, it is not shippable.

---

## 🛠 Technology Stack

| Layer | Technology | Purpose |
|---|---|---|
| Runtime | Node.js v18+ (LTS) | Stable, async I/O, native ESM support |
| Framework | Express.js | RESTful API backbone |
| Database | MongoDB + Mongoose | Flexible schemas for dynamic tournament structures |
| Real-time | Socket.io | Bi-directional event streaming for veto + live state |
| Queue | Agenda.js (MongoDB-backed) | Durable scheduled jobs, auto-retry on failure |
| Auth | JWT (RS256 preferred) | Stateless, role-scoped authentication |
| Frontend | Vanilla JS ES6+, TailwindCSS, GSAP | No framework overhead; maximum control |
| Animation | GSAP 3 | Smooth, GPU-accelerated VCT-style transitions |
| Canvas | html2canvas | Bracket PNG export |
| Discord | Discord.js v14 | Automated channel management + event logging |
| Riot API | Custom utils/riotApi.js | Player PUUID verification + account data |
| Logging | Winston (file + console) | Structured JSON logs, severity levels |
| Security | Helmet, express-rate-limit, bcryptjs | Defense-in-depth |
| Compression | compression | Gzip all responses |

---

## 🎨 Design System — Brutalist-VCT Hybrid

This is the **law**. No deviations without explicit approval.

### Color Palette
```
--color-navy:      #0f1923   /* Primary background — deep tactical dark */
--color-navy-mid:  #1a2535   /* Secondary surfaces, cards */
--color-navy-light:#253545   /* Borders, dividers */
--color-red:       #ff4655   /* VCT Red — CTAs, danger, live indicators */
--color-red-dark:  #c0392b   /* Hover states for red elements */
--color-paper:     #ece8e1   /* Primary text — warm off-white */
--color-paper-dim: #9b9b9b   /* Secondary/muted text */
--color-gold:      #f0b429   /* Winner highlight, 1st place, champion */
--color-green:     #00d4aa   /* Confirmed/picked maps, success states */
--color-blue:      #5edfff   /* Info, attack side, socket events */
```

### Typography
```
Display / Headers  → 'Oswald', sans-serif  (700, uppercase, ls: 0.08em)
Body / Labels      → 'Rajdhani', sans-serif (400/600, clean, compact)
Monospace / Data   → 'Courier New', monospace (timestamps, IDs, scores)
```
- Load via Google Fonts. Always specify `display=swap`.
- Headers: ALL CAPS, minimum 2px letter-spacing.
- Body text: minimum 14px, line-height 1.5.

### Component Rules
- **Borders:** 1–2px solid `var(--color-navy-light)`. Sharp corners (border-radius ≤ 2px).
- **Buttons:** Uppercase text, no border-radius, 2px solid border. On hover: background flip (fill ↔ outline).
- **Cards:** Background `var(--color-navy-mid)`, 1px border, subtle box-shadow `0 0 20px rgba(255,70,85,0.08)`.
- **Live Indicators:** Pulse animation (`@keyframes pulse`) in `--color-red`. Never use static badges for live states.
- **Animations:** GSAP for entrances. CSS transitions for hover (150ms ease). No `setTimeout`-based animations.

---

## 🔐 Security & Authentication Architecture

### Role Hierarchy
```
SUPERADMIN  → Unrestricted. Can create/delete admins. System-level controls.
ADMIN       → Full tournament management, team approval, match control.
TEAM        → Captain-level access. Own match, roster, score reporting only.
PUBLIC      → Read-only. Bracket, schedule, results, team profiles.
```

### Security Contracts
- **Every API route** must be explicitly annotated: `// AUTH: PUBLIC | TEAM | ADMIN | SUPERADMIN`
- **JWT payload** must include: `{ id, role, teamId (if team), iat, exp }`
- **Rate limiting:** Auth endpoints: 20 req/15min. General API: 300 req/min.
- **Input validation:** All user inputs must pass through validation middleware before hitting the database.
- **File uploads:** Only image types (jpeg, png, webp). Max 2MB. Store in `/public/uploads/`. Sanitize filenames.
- **Score submissions:** Must be verified by opposing team captain AND admin before `bracketManager` is triggered.

---

## 📂 System Architecture

```
valorant-tourney/
├── managers/           # State machines — the brain of the system
│   ├── vetoManager.js     # Real-time veto state, timers, Socket.io events
│   └── bracketManager.js  # Bracket generation, score approval, advancement logic
├── middleware/         # Express middleware
│   ├── auth.js            # JWT verification, role guards
│   └── validate.js        # Input sanitization wrappers
├── models/             # Mongoose schemas
│   ├── Match.js           # Full match lifecycle, veto data, scoring
│   ├── Team.js            # Team profile, roster, Riot API data
│   ├── Tournament.js      # Multi-stage tournament configuration
│   ├── User.js            # Admin user accounts
│   └── AdminLog.js        # Immutable audit trail
├── routes/             # Express routers (Domain-Driven)
│   ├── adminRoutes.js
│   ├── matchRoutes.js
│   ├── teamRoutes.js
│   ├── tournamentRoutes.js
│   ├── discordRoutes.js
│   └── overlayRoutes.js
├── services/           # External integrations
│   ├── discordBot.js      # Discord.js bot, slash commands
│   ├── discordService.js  # Channel management, embeds, notifications
│   └── queueService.js    # Agenda job definitions
├── utils/
│   ├── logger.js          # Winston configuration
│   └── riotApi.js         # Riot API client (PUUID lookup, account verification)
├── public/             # Frontend (served statically)
│   ├── index.html         # Public landing page / tournament hub
│   ├── login.html         # Auth page
│   ├── admin.html         # Admin control panel
│   ├── team-dashboard.html # Team captain interface
│   ├── tournament_view.html # Public bracket + schedule viewer
│   ├── veto.html          # Real-time veto interface
│   ├── overlay.html       # OBS/stream overlay
│   ├── caster_dashboard.html # Caster control panel
│   └── post_match.html    # Post-match summary
├── tests/              # Test suites
├── logs/               # Winston log output
├── server.js           # Entry point, Socket.io, middleware, routes
└── GEMINI.md           # This file — system constitution
```

---

## 🔄 Complete Match Lifecycle

```
[SCHEDULED] → Admin sets time + format
     ↓
[CHECK-IN OPEN] → 30min before match, both teams must check in
     ↓         → Auto-forfeit if no check-in within window (via Agenda)
[ROSTER LOCKED] → Rosters frozen on check-in completion
     ↓
[VETO PHASE] → Coin toss / 1v1 determines priority
     ↓         → Real-time map picks/bans via vetoManager.js
     ↓         → 45s timer per action, auto-ban on timeout
[LIVE] → Discord channel created, lobby info distributed
     ↓    → Teams play maps in order
[PENDING APPROVAL] → Winning team submits score + screenshot
     ↓              → Opposing team confirms (or disputes)
     ↓              → Admin approves
[FINISHED] → bracketManager advances winner
     ↓       → Discord result announcement
     ↓       → Channels archived (not deleted, for audit)
[BRACKET UPDATE] → Socket.io broadcasts to all clients
```

---

## 🏗 Engineering Standards

### API Contract
Every response MUST follow this format:
```json
{ "success": true | false, "msg": "Human-readable message", "data": {} | null }
```
Never expose stack traces or internal error messages in production (`NODE_ENV=production`).

### Socket.io Event Naming (`snake_case`)
```
Client → Server:  join_match, join_admin, veto_action, team_ready, send_chat
Server → Client:  match_update, veto_update, bracket_update, teams_update,
                  team_notification, broadcast_message, system_stats, overlay_update
```
Use `io.to(roomId).emit()` for targeted events. **Never** use `io.emit()` for match-specific data.

### Manager Pattern Rules
- `vetoManager.js` and `bracketManager.js` are **the single source of truth**.
- All state mutations go through managers, not directly via routes.
- In-memory state must always be mirrored to MongoDB before emitting socket events.
- Managers must expose a `restoreState(matchId)` method for server restart recovery.

### Database Conventions
- All schemas must have `{ timestamps: true }`.
- Use `lean()` for read-only queries (performance).
- Create compound indexes on frequently queried fields (e.g., `tournament + status`).
- Never use `findOneAndUpdate` with `{ upsert: true }` in production code without explicit justification.

### Logging (Winston)
```js
logger.info('ACTION', { matchId, teamId, detail });  // Every critical action
logger.warn('ANOMALY', { context });                  // Unexpected but recoverable
logger.error('FAILURE', { error: e.message, stack: e.stack }); // All caught errors
```
Log entries MUST include contextual IDs (`matchId`, `teamId`, `tournamentId`) so any event can be traced.

---

## 🎯 Feature Roadmap (Prioritized)

### ✅ Implemented
- Real-time veto system (pick/ban, timer, pause, history)
- Multi-format bracket generation (GSL, Round Robin, Swiss, Double Elim)
- Discord integration (channels, result announcements, bot commands)
- JWT authentication with role-based access control
- Riot API player verification
- Score submission + dispute system
- Admin system health monitor

### 🔥 Active Development Queue
1. **Public Landing Page** — VCT-styled hub, no login required
2. **Public Bracket Viewer** — Read-only bracket, shareable URLs
3. **Standings / Leaderboard** — Real-time W/L/differential for RR & Swiss
4. **Team Profile Pages** — Roster, match history, map stats per team
5. **In-App Notification System** — Toast + bell, real-time via Socket.io
6. **Match Schedule / Calendar** — Timeline view + Google Calendar integration
7. **Tournament Registration System** — Public signup flow with admin approval
8. **Caster Dashboard** — Full overlay control panel for production streams

### 📋 Backlog
- Player Performance Index (ACS, ADR, KAST manual entry)
- Live Stream Overlay API (OBS/vMix WebSocket endpoints)
- Score Dispute UI (evidence upload, admin resolution flow)
- Map Analytics Dashboard (pick/ban/win rates with CSS charts)
- Bracket PNG Export (html2canvas, watermarked)
- Admin Broadcast System (in-app + Discord)
- Tournament Registration (public sign-up + admin approval)
- Tournament Archive (close + preserve stats)
- PWA / Service Worker (offline capability, push notifications)
- Rulebook PDF Generator

---

## 📝 Developer Conventions (Non-Negotiable)

| Convention | Rule |
|---|---|
| Socket events | `snake_case` always |
| JS variables | `camelCase` always |
| API responses | `{ success, msg, data }` always |
| Error handling | Every `async` route must have `try/catch` |
| Auth annotation | Every route must declare its auth level in a comment |
| No magic strings | Use constants for status values (`'pending_approval'`, `'finished'`) |
| No client trust | Validate all inputs server-side, regardless of frontend validation |
| Real-time sync | Never mutate bracket/veto state outside their managers |
| Logging | Every score submission, veto action, and admin override MUST be logged |
| DB queries | Use `.lean()` on read-only queries. Use `.populate()` sparingly |

---

## 🌐 Deployment Considerations

- **Environment Variables:** All secrets in `.env`. Never commit. Use `.env.example` as template.
- **Process Management:** Run with `pm2` in production. Not `nodemon`.
- **MongoDB:** Use Atlas with connection pooling. Enable `retryWrites=true`.
- **Static Assets:** Serve via CDN in production for latency reduction.
- **CORS:** Lock `origin` to the deployed domain in production. Never `*` in prod.
- **Monitoring:** Integrate with a service like Datadog or Better Uptime for SLA tracking.

---

*VALORANT TOURNAMENT PROTOCOL // ASCENDANT TIER // BUILT FOR GRAND FINALS*
