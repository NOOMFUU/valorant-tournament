require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const os = require('os');
// [ADDED] Libraries for Production
const helmet = require('helmet');
const compression = require('compression');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Import Models
const User = require('./models/User');
const Team = require('./models/Team');
const Tournament = require('./models/Tournament');
const Match = require('./models/Match');
const AdminLog = require('./models/AdminLog');

// Import Managers
const VetoManager = require('./managers/vetoManager');
const BracketManager = require('./managers/bracketManager'); 

const app = express();
const server = http.createServer(app);

// [UPDATED] CORS Setup (Allow dynamic origins for dev/prod)
const allowedOrigins = [process.env.CLIENT_URL, 'http://localhost:4000', 'https://your-app.onrender.com'];
const io = new Server(server, { 
    cors: { 
        origin: "*" // หรือใส่ allowedOrigins ถ้าต้องการความเข้มงวด
    } 
});

// --- CONFIGURATION ---
const DEFAULT_LOGO = "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQY6fJtdoDAlMIcjcUyEDsxhhXJYDLrzw7dQg&s";

app.use(cors()); // Basic CORS
// [ADDED] Security & Compression
app.use(helmet({
    contentSecurityPolicy: false, // ปิด CSP ชั่วคราวเพื่อให้โหลดรูปจากเว็บนอกได้ (เช่น valorant-api, cloudinary)
    crossOriginEmbedderPolicy: false
}));
app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- SECURITY: Rate Limiting ---
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 นาที
    max: 100, // จำกัด 100 request ต่อ IP
    message: { msg: "Too many login attempts, please try again later." }
});

app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// --- [UPDATED] STORAGE CONFIGURATION (Cloudinary vs Local) ---
let upload;
if (process.env.CLOUDINARY_URL) {
    // ใช้ Cloudinary (สำหรับ Production/Render)
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    const cloudStorage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: 'valorant-tourney',
            allowed_formats: ['jpg', 'png', 'jpeg', 'gif'],
        },
    });
    upload = multer({ storage: cloudStorage });
    console.log("☁️  Storage: Using Cloudinary");
} else {
    // ใช้ Local Disk (สำหรับ Development)
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = 'public/uploads';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname); 
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + ext); 
        }
    });
    upload = multer({ 
        storage: storage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            if (file.mimetype.startsWith('image/')) cb(null, true);
            else cb(new Error('Only images allowed'), false);
        }
    });
    console.log("📂 Storage: Using Local Disk");
}

// --- MANAGERS INITIALIZATION ---
// สร้าง Manager ก่อน Connect DB เพื่อให้พร้อมเรียกใช้ restoreTimers
const vetoMgr = new VetoManager(io);
BracketManager.setIO(io);

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney')
    .then(async () => {
        console.log('✅ MongoDB Connected');
        
        // [ADDED] กู้คืน Timer ของ Veto กรณี Server รีสตาร์ท
        if (vetoMgr.restoreTimers) {
            await vetoMgr.restoreTimers();
            console.log('⏱️  Veto Timers Restored');
        }
    })
    .catch(err => console.error('❌ MongoDB Error:', err));


// --- CRON JOB: AUTO CHECK-IN & FORFEIT ---
// Run check every 1 minute
setInterval(async () => {
    try {
        const now = new Date();
        const matches = await Match.find({ 
            status: 'scheduled',
            scheduledTime: { $exists: true, $ne: null }
        });

        for (const m of matches) {
            const matchTime = new Date(m.scheduledTime);
            
            // ถ้าเลยเวลาแข่งแล้ว และการ Check-in ยังไม่ครบ
            if (now >= matchTime) {
                let changed = false;
                
                // Team A มา, Team B หาย -> A ชนะ
                if (m.checkIn.teamA && !m.checkIn.teamB) {
                    m.status = 'finished'; 
                    m.winner = m.teamA;
                    m.scoreSubmission.status = 'approved';
                    m.scoreSubmission.rejectReason = 'AUTO: Opponent Missed Check-in';
                    m.name += " (Auto Win)";
                    changed = true;
                } 
                // Team B มา, Team A หาย -> B ชนะ
                else if (!m.checkIn.teamA && m.checkIn.teamB) {
                    m.status = 'finished'; 
                    m.winner = m.teamB;
                    m.scoreSubmission.status = 'approved';
                    m.scoreSubmission.rejectReason = 'AUTO: Opponent Missed Check-in';
                    m.name += " (Auto Win)";
                    changed = true;
                }
                // หายทั้งคู่ -> ปล่อยไว้ก่อน หรือจะปรับแพ้คู่ก็ได้ (ในที่นี้ปล่อยให้ Admin ตัดสินใจ)

                if (changed) {
                    await m.save();
                    
                    // อัปเดต Bracket
                    if (m.winner) {
                        const winnerId = m.winner.toString();
                        const loserId = (winnerId === m.teamA?.toString()) ? m.teamB : m.teamA;
                        
                        // ต้องดึง Team Object มาส่งให้ BracketManager
                        const wTeam = await Team.findById(winnerId);
                        const lTeam = loserId ? await Team.findById(loserId) : null;
                        
                        await BracketManager.propagateMatchResult(m, wTeam, lTeam);
                        
                        // อัปเดตสถิติ
                        await Team.findByIdAndUpdate(winnerId, { $inc: { wins: 1 } });
                        if (lTeam) await Team.findByIdAndUpdate(lTeam._id, { $inc: { losses: 1 } });
                    }
                    
                    io.emit('match_update', m);
                    io.emit('bracket_update');
                }
            }
        }
    } catch (e) { console.error("Auto Check-in Error", e); }
}, 60 * 1000);

// --- SYSTEM STATS MONITOR ---
let lastCpuUsage = process.cpuUsage();
let lastHrTime = process.hrtime();

setInterval(() => {
    try {
        const diffCpu = process.cpuUsage(lastCpuUsage);
        const diffTime = process.hrtime(lastHrTime);
        
        lastCpuUsage = process.cpuUsage();
        lastHrTime = process.hrtime();

        const elapTimeMS = (diffTime[0] * 1000) + (diffTime[1] / 1e6);
        const elapCpuMS = (diffCpu.user + diffCpu.system) / 1000;
        
        // Calculate % (Normalized by core count)
        const numCpus = os.cpus().length;
        const cpuPercent = Math.round((100 * elapCpuMS / elapTimeMS) / numCpus);

        io.emit('system_stats', {
            cpu: cpuPercent,
            mem: { used: process.memoryUsage().rss, total: os.totalmem() },
            concurrent: io.engine.clientsCount,
            uptime: process.uptime()
        });
    } catch (e) { console.error("Stats Error:", e); }
}, 3000);

const getFileUrl = (file) => {
    if (!file) return null;
    // ถ้าเป็น Cloudinary หรือ URL เต็มอยู่แล้ว ให้ใช้เลย
    if (file.path && (file.path.startsWith('http') || file.path.startsWith('https'))) {
        return file.path;
    }
    // ถ้าเป็น Local ให้เติม /uploads/ ข้างหน้า เพื่อให้ Browser เข้าถึงได้
    return `/uploads/${file.filename}`;
};

// --- AUTH MIDDLEWARE ---
const auth = (roles = []) => async (req, res, next) => {
    let t = req.headers['authorization'];
    if (!t) return res.status(401).json({ msg: 'No token' });
    if (t.startsWith('Bearer ')) t = t.slice(7, t.length);

    try {
        const d = jwt.verify(t, process.env.JWT_SECRET);
        if (d.role === 'team') {
            const team = await Team.findById(d.id);
            if (!team || team.status !== 'approved') return res.status(403).json({ msg: 'Team not authorized' });
        }
        if (roles.length && !roles.includes(d.role)) return res.status(403).json({ msg: 'Forbidden' });
        req.user = d;
        next();
    } catch { res.status(401).json({ msg: 'Invalid Token' }); }
};

// --- LOGGING HELPER ---
async function logAdminAction(req, action, target, details) {
    try {
        const u = await User.findById(req.user.id);
        await AdminLog.create({
            adminId: req.user.id,
            adminUsername: u ? u.username : 'Unknown',
            action,
            target,
            details,
            ip: req.ip
        });
    } catch(e) { console.error("Log Error:", e); }
}

// --- AUTH & TEAMS ROUTES ---
app.post('/api/login', async (req,res) => {
    try {
        const { username, password, role } = req.body;
        
        // แปลง input ให้เป็นตัวพิมพ์เล็กเพื่อความแม่นยำ
        const cleanUsername = username.toLowerCase().trim();

        if(role === 'admin') {
            const u = await User.findOne({ username: cleanUsername });
            if(!u || !bcrypt.compareSync(password, u.password)) return res.status(400).json({msg:'Invalid Credentials'});
            return res.json({token:jwt.sign({id:u._id, role:'admin'}, process.env.JWT_SECRET), role:'admin'});
        }

        // ค้นหา Team ด้วย username
        const t = await Team.findOne({ username: cleanUsername });
        
        if(!t || !bcrypt.compareSync(password, t.password)) return res.status(400).json({msg:'Invalid Credentials'});
        if(t.status !== 'approved') return res.status(403).json({msg:'Team account not approved yet'});
        
        // Payload ส่ง name (Display Name) ไปแสดงผล แต่ id ยังคงเดิม
        res.json({token:jwt.sign({id:t._id, role:'team', name:t.name}, process.env.JWT_SECRET), role:'team', id:t._id});
    } catch (e) { res.status(500).json({msg: 'Server Error'}); }
});
// [UPDATED] Register using Cloudinary-aware upload
app.post('/api/register', upload.single('logo'), async(req,res)=>{
    try {
        // รับ username เพิ่มเข้ามา
        const { username, name, shortName, password } = req.body;
        const cleanUsername = username.toLowerCase().trim();

        const logo = req.file ? getFileUrl(req.file) : DEFAULT_LOGO;        

        // Check 1: Username ซ้ำไหม?
        const existingUser = await Team.findOne({ username: cleanUsername });
        if(existingUser) return res.status(400).json({msg: 'Username is already taken'});

        // Check 2: Team Name (Display Name) ซ้ำไหม? (ยังควรเช็คเพื่อไม่ให้สับสนในการแข่ง)
        const existingName = await Team.findOne({ name: name });
        if(existingName) return res.status(400).json({msg: 'Team Name is already registered'});
        
        await new Team({
            username: cleanUsername,
            name,
            shortName,
            password: bcrypt.hashSync(password, 10),
            logo,
            status: 'pending'
        }).save();
        
        res.json({success:true});
    } catch (e) { res.status(500).json({msg: e.message}); }
});

app.post('/api/teams/:id/approve', auth(['admin']), async(req,res)=>{ await Team.findByIdAndUpdate(req.params.id,{status:'approved'}); res.json({success:true}); });
app.delete('/api/teams/:id', auth(['admin']), async(req,res)=>{ await Team.findByIdAndDelete(req.params.id); res.json({success:true}); });
app.get('/api/teams', async(_,res)=>res.json(await Team.find()));
app.get('/api/teams/me', auth(['team']), async(req,res)=>res.json(await Team.findById(req.user.id)));

// [NEW] Reset Team Stats (Wins/Losses)
app.post('/api/teams/reset-stats', auth(['admin']), async (req, res) => {
    try {
        await Team.updateMany({}, { wins: 0, losses: 0 });
        await logAdminAction(req, 'RESET_STATS', 'All Teams', { msg: 'Wins/Losses reset to 0' });
        io.emit('teams_update');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Import Teams from CSV
const csvUpload = multer({ storage: multer.memoryStorage() });
app.post('/api/teams/import', auth(['admin']), csvUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });

        const fileContent = req.file.buffer.toString('utf8');
        const lines = fileContent.split(/\r?\n/);
        let updated = 0, created = 0, errors = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            // Skip header or empty lines
            if (!line || (i === 0 && (line.toLowerCase().startsWith('team name') || line.toLowerCase().includes('username')))) continue;

            // Format: Team Name, Short Name, Username, Password, M1_Name, M1_Tag, M2_Name, M2_Tag...
            const cols = line.split(',').map(s => s.trim());
            
            if (cols.length < 4) { errors++; continue; }

            const name = cols[0];
            const shortName = cols[1];
            const username = cols[2];
            const password = cols[3];

            if (!username || !password) {
                if (line) errors++;
                continue;
            }

            // Parse Roster
            const members = [];
            const addMember = (nameCol, tagCol, role) => {
                if(!nameCol) return;
                let mName = nameCol.trim();
                let mTag = tagCol ? tagCol.trim().replace('#','') : '0000';
                
                // Fallback: Support Name#Tag in name column if tag column is empty
                if (mName.includes('#') && mTag === '0000') {
                    const parts = mName.split('#');
                    mName = parts[0].trim();
                    mTag = parts[1].trim();
                }

                if(mName) members.push({ role, name: mName, tag: mTag, status: 'approved' });
            };

            // Mains (5 players): Cols 4,5 | 6,7 | 8,9 | 10,11 | 12,13
            for(let i=0; i<5; i++) { const idx = 4 + (i*2); addMember(cols[idx], cols[idx+1], 'Main'); }
            // Subs (2 players): Cols 14,15 | 16,17
            for(let i=0; i<2; i++) { const idx = 14 + (i*2); addMember(cols[idx], cols[idx+1], 'Sub'); }
            // Coach: Cols 18,19
            addMember(cols[18], cols[19], 'Coach');

            const cleanUser = username.toLowerCase();
            const existing = await Team.findOne({ username: cleanUser });

            if (existing) {
                existing.password = bcrypt.hashSync(password, 10);
                if (name) existing.name = name;
                if (shortName) existing.shortName = shortName.toUpperCase();
                if (members.length > 0) existing.members = members;
                await existing.save();
                updated++;
            } else if (name && shortName) {
                await new Team({ 
                    username: cleanUser, 
                    password: bcrypt.hashSync(password, 10), 
                    name, 
                    shortName: shortName.toUpperCase(), 
                    status: 'approved',
                    members: members
                }).save();
                created++;
            } else { errors++; }
        }

        await logAdminAction(req, 'IMPORT_TEAMS', 'CSV Import', { created, updated, errors });
        io.emit('teams_update');
        res.json({ success: true, msg: `Imported: ${created} created, ${updated} updated.` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Roster Management
app.put('/api/teams/roster', auth(['team']), async(req,res)=>{ 
    try {
        const team = await Team.findById(req.user.id);
        const newMembers = req.body.members; 
        
        if (!team.rosterLocked) {
            team.members = newMembers.map(m => ({ ...m, status: 'approved', pendingUpdate: null }));
            team.rosterLocked = true; 
            await team.save();
            return res.json({success: true, msg: 'Roster initialized.'});
        } 
        
        const updatedMembers = [];
        for (let i = 0; i < 8; i++) {
            const incoming = newMembers[i] || null;
            const existing = team.members[i] || null;

            if (incoming && (!existing || incoming.name !== existing.name || incoming.tag !== existing.tag)) {
                updatedMembers.push({
                    role: incoming.role,
                    name: existing ? existing.name : "", 
                    tag: existing ? existing.tag : "",
                    status: 'pending',
                    pendingUpdate: { name: incoming.name, tag: incoming.tag }
                });
            } else if (existing) {
                updatedMembers.push(existing);
            }
        }
        team.members = updatedMembers;
        await team.save();
        io.emit('teams_update');
        res.json({success: true, msg: 'Changes submitted for approval.'});
    } catch(e) { res.status(500).json({msg: 'Server Error'}); }
});

app.put('/api/teams/:id', auth(['admin']), async (req, res) => {
    try {
        const { name, shortName, wins, losses } = req.body;
        
        // Validations
        if (!name || !shortName) return res.status(400).json({ msg: 'Name and Short Name are required' });

        // Check if new name already exists (excluding current team)
        const existingName = await Team.findOne({ name: name, _id: { $ne: req.params.id } });
        if (existingName) return res.status(400).json({ msg: 'Team Name is already taken' });

        const updateData = {
            name: name,
            shortName: shortName.toUpperCase()
        };
        if (wins !== undefined) updateData.wins = parseInt(wins);
        if (losses !== undefined) updateData.losses = parseInt(losses);

        // Update
        const updatedTeam = await Team.findByIdAndUpdate(req.params.id, updateData, { new: true });

        if (!updatedTeam) return res.status(404).json({ msg: 'Team not found' });

        if (wins !== undefined || losses !== undefined) {
            await logAdminAction(req, 'UPDATE_TEAM', `Team ${updatedTeam.name}`, { wins, losses });
        }

        io.emit('teams_update'); // แจ้ง Client ให้รีเฟรชข้อมูล
        res.json({ success: true, team: updatedTeam });
    } catch (e) {
        console.error(e);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// [ADDED] Admin Reset Team Password
app.put('/api/teams/:id/reset-password', auth(['admin']), async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword) return res.status(400).json({ msg: 'New password is required' });

        const hash = bcrypt.hashSync(newPassword, 10);
        await Team.findByIdAndUpdate(req.params.id, { password: hash });

        res.json({ success: true, msg: 'Password updated successfully' });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

app.put('/api/teams/:id/members/:mid/status', auth(['admin']), async(req,res)=>{
    try {
        const { status } = req.body;
        const team = await Team.findById(req.params.id);
        const member = team.members.id(req.params.mid);
        
        if(member) {
            if (status === 'approved') {
                if (member.pendingUpdate && member.pendingUpdate.name) {
                    member.name = member.pendingUpdate.name;
                    member.tag = member.pendingUpdate.tag;
                }
                member.status = 'approved';
                member.pendingUpdate = null; 
            } else if (status === 'rejected') {
                if (member.name && member.pendingUpdate) {
                    member.status = 'approved'; 
                    member.pendingUpdate = null;
                } else {
                    member.status = 'rejected';
                    member.pendingUpdate = null;
                }
            }
            await team.save();
            io.emit('teams_update');
            res.json({success:true});
        } else {
            res.status(404).json({msg:'Member not found'});
        }
    } catch(e) { res.status(500).json(e); }
});

app.delete('/api/teams/:id/members/:mid', auth(['admin']), async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);
        team.members = team.members.filter(m => m._id.toString() !== req.params.mid);
        await team.save();
        io.emit('teams_update');
        res.json({ success: true });
    } catch (e) { res.status(500).json(e); }
});

// [UPDATED] Upload Logo
app.put('/api/teams/logo', auth(['team']), upload.single('logo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });
        const logoPath = getFileUrl(req.file);        
        await Team.findByIdAndUpdate(req.user.id, { logo: logoPath });
        res.json({ success: true, logo: logoPath });
    } catch (e) { res.status(500).json({ msg: 'Error' }); }
});

// [NEW] Get Admin Logs
app.get('/api/admin/logs', auth(['admin']), async (req, res) => {
    try {
        const logs = await AdminLog.find().sort({ createdAt: -1 }).limit(100);
        res.json(logs);
    } catch(e) { res.status(500).json({ msg: e.message }); }
});

// --- MATCH ROUTES ---

app.get('/api/matches', async (_, res) => {
    try {
        const matches = await Match.find()
            .populate({ path: 'teamA', populate: { path: 'members' } })
            .populate({ path: 'teamB', populate: { path: 'members' } })
            .populate('winner')
            .populate('tournament');
        res.json(matches);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Get Upcoming Matches for Logged-in Team (Dashboard UX)
app.get('/api/matches/upcoming', auth(['team']), async (req, res) => {
    try {
        const teamId = req.user.id;
        if (!mongoose.Types.ObjectId.isValid(teamId)) return res.status(400).json({ msg: 'Invalid Team ID' });

        const matches = await Match.find({
            $or: [{ teamA: teamId }, { teamB: teamId }],
            status: { $in: ['scheduled', 'live', 'pending_approval'] }
        })
        .populate('teamA')
        .populate('teamB')
        .populate('tournament')
        .sort({ scheduledTime: 1 }); // Soonest first
        
        res.json(matches);
    } catch (e) { 
        console.error("Error in /api/matches/upcoming:", e);
        res.status(500).json({ msg: e.message }); 
    }
});

// [NEW] Get Match History for Logged-in Team
app.get('/api/matches/history', auth(['team']), async (req, res) => {
    try {
        const teamId = req.user.id;
        const matches = await Match.find({
            $or: [{ teamA: teamId }, { teamB: teamId }],
            status: 'finished'
        })
        .populate('teamA teamB tournament')
        .sort({ updatedAt: -1 }); // Most recent first
        
        res.json(matches);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.get('/api/matches/:id', async (req, res) => {
    try {
        const match = await Match.findById(req.params.id)
            .populate({ path: 'teamA', populate: { path: 'members' } })
            .populate({ path: 'teamB', populate: { path: 'members' } });
        res.json(match);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.delete('/api/matches/:id', auth(['admin']), async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        await Tournament.updateMany({ "stages.matches": req.params.id }, { $pull: { "stages.$[].matches": req.params.id } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.put('/api/matches/:id', auth(['admin']), async(req, res) => {
    try {
        const { format, name, status, scheduledTime } = req.body;
        const update = {};
        if(format) update.format = format;
        if(name) update.name = name;
        if(status) update.status = status;
        if(scheduledTime !== undefined) update.scheduledTime = scheduledTime;

        const match = await Match.findByIdAndUpdate(req.params.id, update, {new: true});
        io.emit('match_update', match);
        res.json({ success: true, match });
    } catch(e) { res.status(500).json(e); }
});

// [NEW] Swap Teams Endpoint (Drag & Drop)
app.post('/api/matches/swap-teams', auth(['admin']), async (req, res) => {
    try {
        const { match1Id, slot1, match2Id, slot2 } = req.body;
        
        const m1 = await Match.findById(match1Id);
        const m2 = await Match.findById(match2Id);

        if (!m1 || !m2) return res.status(404).json({ msg: 'Match not found' });

        const team1 = m1[slot1];
        const team2 = m2[slot2];
        
        // Swap Teams
        m1[slot1] = team2;
        m2[slot2] = team1;

        await m1.save();
        await m2.save();

        await logAdminAction(req, 'SWAP_TEAMS', `Swapped ${slot1} of Match ${m1.matchNumber} with ${slot2} of Match ${m2.matchNumber}`, {});

        io.emit('match_update', m1);
        io.emit('match_update', m2);
        io.emit('bracket_update');

        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Force Winner (Admin)
app.post('/api/matches/:id/force-winner', auth(['admin']), async (req, res) => {
    try {
        const { winnerId } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        
        const winner = match.teamA._id.toString() === winnerId ? match.teamA : match.teamB;
        const loser = match.teamA._id.toString() === winnerId ? match.teamB : match.teamA;

        match.winner = winner;
        match.status = 'finished';
        match.scoreSubmission.status = 'approved';
        match.scoreSubmission.rejectReason = 'Admin Override';
        
        await match.save();
        await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
        await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });

        await BracketManager.propagateMatchResult(match, winner, loser);

        await logAdminAction(req, 'FORCE_WINNER', `Match ${match.matchNumber} (${match.name})`, { winner: winner.name });

        io.emit('match_update', match);
        io.emit('bracket_update');
        res.json({ success: true, msg: `Forced win for ${winner.name}` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Submit Score (Team) - [UPDATED] Uses upload (Cloudinary/Local)
app.post('/api/matches/:id/submit-score', auth(['team']), upload.any(), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if(!match) return res.status(404).json({msg:'Match not found'});

        let scores = JSON.parse(req.body.scores);
        req.files.forEach(file => {
            const parts = file.fieldname.split('_'); 
            if(parts.length === 2 && parts[0] === 'proof') {
                const index = parseInt(parts[1]);
                if(scores[index]) {
                    // [แก้ตรงนี้]
                    scores[index].proofImage = getFileUrl(file);
                }
            }
        });

        match.scoreSubmission = { submittedBy: req.user.id, tempScores: scores, status: 'pending' };
        match.status = 'pending_approval';
        await match.save();
        io.emit('match_update', match);
        res.json({ success: true });
    } catch(e) { res.status(500).json({msg: e.message}); }
});

// Claim Forfeit (Team) - [UPDATED] Uses upload (Cloudinary/Local)
app.post('/api/matches/:id/claim-forfeit', auth(['team']), upload.single('proof'), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if(!match) return res.status(404).json({msg:'Match not found'});
        if(match.status === 'finished') return res.status(400).json({msg:'Match already finished'});

        if (!match.scheduledTime) return res.status(400).json({msg:'Match has no scheduled time'});
        const diffMinutes = (new Date() - new Date(match.scheduledTime)) / 1000 / 60;
        
        if (diffMinutes < 15) return res.status(400).json({msg:`Wait at least 15 minutes after schedule time`});
        if (!req.file) return res.status(400).json({msg:'Proof screenshot is required'});

        const isTeamA = match.teamA._id.toString() === req.user.id;
        const mapCount = match.format === 'BO1' ? 1 : (match.format === 'BO3' ? 2 : 3);
        const forfeitScores = [];
        
        for(let i=0; i<mapCount; i++) {
            forfeitScores.push({
                mapName: `Forfeit Map ${i+1}`,
                teamAScore: isTeamA ? 13 : 0,
                teamBScore: isTeamA ? 0 : 13,
                proofImage: getFileUrl(req.file)
            });
        }

        match.scoreSubmission = {
            submittedBy: req.user.id,
            tempScores: forfeitScores,
            status: 'pending',
            rejectReason: 'FORFEIT CLAIM' 
        };
        match.status = 'pending_approval';
        await match.save();
        io.emit('match_update', match);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ msg: e.message }); }
});

// Approve Score (Admin)
app.post('/api/matches/:id/approve-score', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB nextMatchId loserMatchId');
        if(!match) return res.status(404).json({msg:'Not found'});

        match.scores = match.scoreSubmission.tempScores;
        let wA = 0, wB = 0;
        match.scores.forEach(s => {
            if(parseInt(s.teamAScore) > parseInt(s.teamBScore)) wA++; 
            else if(parseInt(s.teamBScore) > parseInt(s.teamAScore)) wB++;
        });
        
        const winner = wA > wB ? match.teamA : match.teamB;
        const loser = wA > wB ? match.teamB : match.teamA;
        
        match.winner = winner;
        match.status = 'finished';
        if(match.scoreSubmission.rejectReason === 'FORFEIT CLAIM') match.name += " (Forfeit)";
        match.scoreSubmission.status = 'approved';
        await match.save();

        await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
        await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });

        await BracketManager.propagateMatchResult(match, winner, loser);

        await logAdminAction(req, 'APPROVE_SCORE', `Match ${match.matchNumber} (${match.name})`, { winner: winner.name });

        io.emit('match_update', match);
        io.emit('bracket_update');
        res.json({ success: true });
    } catch (e) { res.status(500).json({msg: e.message}); }
});

app.post('/api/matches/:id/reject-score', auth(['admin']), async (req, res) => {
    try {
        const { reason } = req.body;
        const match = await Match.findById(req.params.id);
        match.status = 'live'; 
        match.scoreSubmission.status = 'rejected';
        match.scoreSubmission.rejectReason = reason || 'Rejected';
        match.scoreSubmission.tempScores = []; 
        await match.save();
        await logAdminAction(req, 'REJECT_SCORE', `Match ${match.matchNumber} (${match.name})`, { reason });
        io.emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: 'Server error' }); }
});

app.put('/api/matches/:id/manual-score', auth(['admin']), async (req, res) => {
    try {
        const { scores } = req.body;
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if(!match) return res.status(404).json({msg:'Match not found'});

        match.scores = scores;
        
        // Auto-calculate winner
        let wA = 0, wB = 0;
        scores.forEach(s => {
            const sA = parseInt(s.teamAScore) || 0;
            const sB = parseInt(s.teamBScore) || 0;
            if (sA > sB) wA++;
            else if (sB > sA) wB++;
        });

        const mapsNeeded = match.format === 'BO1' ? 1 : (match.format === 'BO3' ? 2 : 3);
        const wasFinished = match.status === 'finished';

        if (wA >= mapsNeeded || wB >= mapsNeeded) {
            const winner = wA > wB ? match.teamA : match.teamB;
            const loser = wA > wB ? match.teamB : match.teamA;

            if (winner && loser) {
                match.winner = winner;
                match.status = 'finished';
                match.scoreSubmission.status = 'approved';
                match.scoreSubmission.rejectReason = 'Admin Manual Entry';

                if (!wasFinished) {
                    await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
                    await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });
                }

                await BracketManager.propagateMatchResult(match, winner, loser);
                io.emit('bracket_update');
            }
        }

        await match.save();
        await logAdminAction(req, 'MANUAL_SCORE', `Match ${match.matchNumber} (${match.name})`, { scores });

        io.emit('match_update', match);
        res.json({ success: true });
    } catch(e) { 
        console.error(e);
        res.status(500).json({ msg: e.message }); 
    }
});

app.post('/api/matches/:id/reset-veto', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        // Reset using default fallback or empty, VetoManager will sync later
        match.vetoData = {
            status: 'pending', mapPool: [],
            bannedMaps: [], pickedMaps: [], history: [], sequence: [], sequenceIndex: 0,
            teamAReady: false, teamBReady: false
        };
        match.status = 'scheduled';
        match.roomPassword = "";
        match.scores = [];
        match.winner = null;
        await match.save();
        io.emit('match_update', match);
        res.json({ success: true });
    } catch(e) { res.status(500).json(e); }
});

app.post('/api/matches/:id/reset', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        match.status = 'scheduled';
        match.winner = null;
        match.scores = [];
        match.roomPassword = ""; 
        match.scoreSubmission = { status: 'none', tempScores: [] };
        match.checkIn = { teamA: false, teamB: false, windowOpen: false };
        match.vetoData = {
            status: 'pending',
            mapPool: [],
            bannedMaps: [], pickedMaps: [], history: [], sequence: [], sequenceIndex: 0,
            teamAReady: false, teamBReady: false
        };

        await match.save();
        await logAdminAction(req, 'RESET_MATCH', `Match ${match.matchNumber} (${match.name})`, {});
        io.emit('match_update', match);
        io.emit('bracket_update'); 
        res.json({ success: true, msg: 'Match has been reset for rematch.' });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] CHECK-IN ENDPOINT
app.post('/api/matches/:id/checkin', auth(['team']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        
        if (!match.scheduledTime) return res.status(400).json({ msg: 'Match has no scheduled time' });
        
        const now = new Date();
        const matchTime = new Date(match.scheduledTime);
        const diffMinutes = (matchTime - now) / 1000 / 60;

        // Allow check-in within 30 mins before match (and logic for Admin override if windowOpen=true)
        if (diffMinutes > 30 && !match.checkIn.windowOpen) return res.status(400).json({ msg: 'Check-in not open yet (Opens 30m before)' });
        if (diffMinutes < -10 && !match.checkIn.windowOpen) return res.status(400).json({ msg: 'Check-in closed' }); 

        const teamId = req.user.id;
        let checked = false;

        if (match.teamA && match.teamA.toString() === teamId) {
            match.checkIn.teamA = true; checked = true;
        } else if (match.teamB && match.teamB.toString() === teamId) {
            match.checkIn.teamB = true; checked = true;
        }

        if (checked) {
            await match.save();
            io.emit('match_update', match);
            res.json({ success: true, msg: 'Check-in Successful' });
        } else {
            res.status(403).json({ msg: 'You are not in this match' });
        }

    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Reschedule Request
app.post('/api/matches/:id/reschedule', auth(['team']), async (req, res) => {
    try {
        const { proposedTime } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        
        if (match.teamA.toString() !== req.user.id && match.teamB.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Unauthorized' });
        }
        if (match.status !== 'scheduled') return res.status(400).json({ msg: 'Match not scheduled' });

        match.rescheduleRequest = {
            requestedBy: req.user.id,
            proposedTime: new Date(proposedTime),
            status: 'pending'
        };
        await match.save();
        io.emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Reschedule Response
app.post('/api/matches/:id/reschedule/respond', auth(['team']), async (req, res) => {
    try {
        const { action } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        
        if (match.rescheduleRequest.status !== 'pending') return res.status(400).json({ msg: 'No pending request' });
        if (match.rescheduleRequest.requestedBy.toString() === req.user.id) return res.status(400).json({ msg: 'Cannot respond to own request' });
        if (match.teamA.toString() !== req.user.id && match.teamB.toString() !== req.user.id) return res.status(403).json({ msg: 'Unauthorized' });

        if (action === 'accept') {
            match.scheduledTime = match.rescheduleRequest.proposedTime;
            match.checkIn = { teamA: false, teamB: false, windowOpen: false }; // Reset check-in
        }
        match.rescheduleRequest = { status: 'none' }; // Clear request
        await match.save();
        io.emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Admin Broadcast Message
app.post('/api/admin/broadcast', auth(['admin']), async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ msg: 'Message required' });
        io.emit('notification', { msg: `📢 ADMIN: ${message}` });
        await logAdminAction(req, 'BROADCAST', 'All Users', { message });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- TOURNAMENT ROUTES ---
app.get('/api/tournaments', async (_, res) => {
    const t = await Tournament.find().populate('participants').sort({ createdAt: -1 });
    res.json(t);
});

// [NEW] Public Tournament Data (Optimized for Frontend Bracket/Schedule View)
app.get('/api/tournaments/:id/public', async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id)
            .select('-stages.matches.roomPassword -stages.matches.chat') // Exclude sensitive match data
            .populate({
                path: 'participants',
                select: 'name shortName logo wins losses'
            })
            .populate({
                path: 'stages.matches',
                populate: { 
                    path: 'teamA teamB winner',
                    select: 'name shortName logo'
                },
                select: '-roomPassword -chat -vetoData.history' // Exclude heavy/private data
            });

        if (!tournament) return res.status(404).json({ msg: 'Tournament not found' });
        res.json(tournament);
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/api/tournaments', auth(['admin']), async (req, res) => {
    const { name, teamIds, mapPool } = req.body; 
    
    await Tournament.deleteMany({}); 
    await Match.deleteMany({}); 
    
    const tournament = new Tournament({ 
        name, 
        participants: teamIds, 
        mapPool: mapPool,
        status: 'active' 
    });
    
    await tournament.save();
    res.json({ success: true, id: tournament._id });
});

app.put('/api/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const { name, mapPool } = req.body;
        await Tournament.findByIdAndUpdate(req.params.id, { name, mapPool });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

// [UPDATED] GENERATE STAGE: Manual Seeding & Third Place
app.post('/api/tournaments/:id/stages/generate', auth(['admin']), async (req, res) => {
    try {
        const { name, type, participants, settings } = req.body;
        const tournament = await Tournament.findById(req.params.id).populate({
            path: 'stages.matches',
            populate: { path: 'teamA teamB winner' }
        });
        
        let finalParticipants = [];

        // 1. STAGE-TO-STAGE LOGIC
        if (settings.sourceStageIndex >= 0 && tournament.stages[settings.sourceStageIndex]) {
            const sourceStage = tournament.stages[settings.sourceStageIndex];
            const sourceMatches = sourceStage.matches;
            
            // --- CASE A: From GSL (Groups) -> Bracket (Cross Seeding) ---
            if (sourceStage.type === 'gsl' && settings.advanceMethod === 'cross_group') {
                const groupWinners = [];
                const groupRunnersUp = [];
                
                sourceMatches.forEach(m => {
                    if (m.status === 'finished' && m.winner) {
                        if (m.name.includes('Winners')) groupWinners.push({ team: m.winner, match: m });
                        if (m.name.includes('Decider')) groupRunnersUp.push({ team: m.winner, match: m });
                    }
                });

                const getGroupChar = (n) => n.split('Group ')[1]?.[0] || 'Z';
                groupWinners.sort((a,b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));
                groupRunnersUp.sort((a,b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));

                finalParticipants = [
                    ...groupWinners.map(x => x.team), 
                    ...groupRunnersUp.map(x => x.team)
                ];
                
                const teamsDb = await Team.find({ _id: { $in: finalParticipants } });
                finalParticipants = finalParticipants.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t=>t);

            } 
            // --- CASE B: From League/Swiss (Top N) ---
            else if (['round_robin', 'swiss'].includes(sourceStage.type)) {
                 let stats = {};
                 sourceStage.stageParticipants.forEach(tid => { stats[tid] = { id: tid, wins: 0, diff: 0 }; });
                 
                 sourceMatches.forEach(m => {
                    if (m.status === 'finished' && m.winner) {
                        if (stats[m.winner._id]) stats[m.winner._id].wins++;
                        let sA=0, sB=0;
                        m.scores.forEach(s => { sA += parseInt(s.teamAScore)||0; sB += parseInt(s.teamBScore)||0; });
                        const winnerDiff = Math.abs(sA - sB);
                        if (stats[m.winner._id]) stats[m.winner._id].diff += winnerDiff;
                    }
                 });

                 const sortedIds = Object.values(stats)
                    .sort((a,b) => b.wins - a.wins || b.diff - a.diff)
                    .map(s => s.id);
                 
                 const count = settings.advanceCount || sortedIds.length;
                 const selectedIds = sortedIds.slice(0, count);
                 
                 const teamsDb = await Team.find({ _id: { $in: selectedIds } });
                 finalParticipants = selectedIds.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t=>t);
            } 
            else {
                // Fallback: Use manual selection provided in body
                const teamsDb = await Team.find({ _id: { $in: participants } });
                finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
            }

        } else {
            // Manual Mode
            const teamsDb = await Team.find({ _id: { $in: participants } });
            finalParticipants = participants.map(id => teamsDb.find(t => t._id.toString() === id)).filter(t => t);
        }
        
        const matchesIds = await BracketManager.generateStage(tournament._id, name, type, finalParticipants, settings);

        tournament.stages.push({ 
            name, type, settings, 
            stageParticipants: finalParticipants.map(t => t._id), 
            matches: matchesIds 
        });
        
        await tournament.save();
        res.json({ success: true });
        
    } catch(e) { 
        console.error(e); 
        res.status(500).json({ msg: e.message }); 
    }
});

app.post('/api/tournaments/:id/stages/:stageIndex/matches', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const { teamA, teamB, format, scheduledTime, name } = req.body;
        const tournament = await Tournament.findById(id);
        
        const lastMatch = await Match.findOne({ tournament: id }).sort({ matchNumber: -1 });
        const nextNum = (lastMatch && lastMatch.matchNumber) ? lastMatch.matchNumber + 1 : 1;

        const newMatch = new Match({
            tournament: id, 
            name: name || 'Extra Match', 
            matchNumber: nextNum, 
            teamA: teamA, teamB: teamB, format: format || 'BO3',
            scheduledTime: scheduledTime || new Date(), status: 'scheduled',
            vetoData: { status: 'pending' }, scores: [], roomPassword: ""
        });
        const savedMatch = await newMatch.save();
        tournament.stages[stageIndex].matches.push(savedMatch._id);
        await tournament.save();
        io.emit('match_update', savedMatch); io.emit('bracket_update');            
        res.json({ success: true, match: savedMatch });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/api/tournaments/:id/stages/:stageIndex/swiss-next', auth(['admin']), async (req, res) => {
    try {
        const { id, stageIndex } = req.params;
        const newMatches = await BracketManager.generateNextSwissRound(id, stageIndex);
        io.emit('bracket_update');
        res.json({ success: true, matchesCreated: newMatches.length });
    } catch (e) { 
        console.error(e); 
        res.status(500).json({ msg: e.message }); 
    }
});

// [NEW] Get Stage Standings (Round Robin / Swiss)
app.get('/api/tournaments/:id/stages/:stageIndex/standings', async (req, res) => {
    try {
        const standings = await BracketManager.getStageStandings(req.params.id, req.params.stageIndex);
        res.json(standings);
    } catch (e) {
        res.status(500).json({ msg: e.message });
    }
});

app.delete('/api/tournaments/:id/stages/:stageIndex', auth(['admin']), async (req, res) => {
    try {
        const tournament = await Tournament.findById(req.params.id);
        const stageIndex = parseInt(req.params.stageIndex);
        const stage = tournament.stages[stageIndex];
        if (stage.matches && stage.matches.length > 0) await Match.deleteMany({ _id: { $in: stage.matches } });
        tournament.stages.splice(stageIndex, 1);
        await tournament.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.delete('/api/tournaments/:id', auth(['admin']), async (req, res) => {
    try {
        const tId = req.params.id;
        await Match.deleteMany({ tournament: tId });
        await Tournament.findByIdAndDelete(tId);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Socket.io Events
io.on('connection', (socket) => {
    socket.on('join_match', (id) => { socket.join(id); vetoMgr.broadcastState(id); });
    socket.on('set_room_pass', (d) => vetoMgr.handleSetRoomPass(d.matchId, d.teamId, d.password));
    socket.on('send_chat', (d) => vetoMgr.handleChat(d.matchId, d.teamId, d.message));
    socket.on('team_ready', (d) => vetoMgr.handleReady(d.matchId, d.teamId));
    socket.on('decision_made', (d) => vetoMgr.handleDecision(d.matchId, d.teamId, d.choice));
    socket.on('veto_action', (d) => vetoMgr.handleAction(d.matchId, d.teamId, d.action, d.map, d.side));
});

server.listen(process.env.PORT || 3000, () => console.log('🚀 Server Running...'));