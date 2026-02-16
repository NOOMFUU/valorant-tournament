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
const cron = require('node-cron');
const csv = require('csv-parser');
const { Client, GatewayIntentBits, PermissionsBitField, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
// [ADDED] Libraries for Production
const helmet = require('helmet');
const compression = require('compression');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
let imgbbUploader;
try {
    imgbbUploader = require('imgbb-uploader');
} catch (e) {
    // imgbb-uploader is optional unless IMGBB_API_KEY is set
}

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

// --- DISCORD BOT SETUP ---
const discordClient = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID; // Your Server ID
const DISCORD_CATEGORY_ID = process.env.DISCORD_MATCH_CATEGORY_ID; // Category for Match Channels
const DISCORD_CLAIM_CHANNEL_ID = process.env.DISCORD_CLAIM_CHANNEL_ID; // Channel to send claim button

discordClient.once('ready', () => {
    console.log(`🤖 Discord Bot Logged in as ${discordClient.user.tag}`);
    discordClient.user.setActivity('Valorant Comp', { type: 'COMPETING' }); //Set status to "Competing in Valorant Comp"
});

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    if (interaction.customId === 'claim_role') {
        await interaction.deferReply({ ephemeral: true });

        try {
            const discordId = interaction.user.id;
            // Find team member with this Discord ID
            const team = await Team.findOne({ "members.discordId": discordId });

            if (!team) {
                return interaction.editReply({ content: "❌ No registered player found with your Discord ID. Please contact an admin." });
            }

            const member = team.members.find(m => m.discordId === discordId);
            const guild = interaction.guild;

            // Get or Create Role
            let role;
            if (team.discordRoleId) {
                role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
            }

            if (!role) {
                // Create role if it doesn't exist
                role = await guild.roles.create({
                    name: team.name,
                    color: '#ff4655', // Valorant Red
                    reason: 'Tournament Team Role'
                });
                team.discordRoleId = role.id;
                await team.save();
            }

            // Assign Role
            const guildMember = await guild.members.fetch(discordId);
            await guildMember.roles.add(role);

            // Update nickname (Optional)
            // await guildMember.setNickname(`${team.shortName} ${member.name}`).catch(e => console.log("Cannot set nick"));

            interaction.editReply({ content: `✅ Verified! You have been assigned the **${team.name}** role.` });

        } catch (error) {
            console.error("Discord Claim Error:", error);
            interaction.editReply({ content: "⚠️ An error occurred while processing your request." });
        }
    }
});

discordClient.on('messageCreate', async message => {
    if (message.content === '!claim') {
        try {
            const discordName = message.author.username;
            const teamMember = await Team.findOne({ "members.discordName": discordName });
            if (!teamMember) {
                return message.reply("❌ No team found with this discord name, contact the admin");
            }
            const member = teamMember.members.find(m => m.discordName === discordName);
            if (!member) {
                return message.reply("❌ The member wasn't found, contact the admin");
            }

            const guild = message.guild;
            let role = await guild.roles.fetch(teamMember.discordRoleId).catch(() => null);

            if (!role) {
                return message.reply("❌ Admin hasn't created the role yet");
            }

            const guildMember = await guild.members.fetch(message.author.id);
            if (!guildMember) {
                return message.reply("❌ Could not find you, contact the admin");
            }

            await guildMember.roles.add(role);

            // Update nickname (Optional)
            // await guildMember.setNickname(`${team.shortName} ${member.name}`).catch(e => console.log("Cannot set nick"));

            message.reply(`✅ Verified! You have been assigned the **${teamMember.name}** role.`);
        } catch (e) {
            console.log("❌ There was an error, please contact the admin");
        }
    }
});

if (process.env.DISCORD_TOKEN) {
    discordClient.login(process.env.DISCORD_TOKEN);
}

// Helper: Create Private Match Channel
async function createMatchChannel(match) {
    if (!match.teamA || !match.teamB || !match.scheduledTime) return;
    if (match.discordChannelId) return; // Already created

    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
        if (!guild) return;

        // Ensure roles exist (or fetch them)
        const teamA = await Team.findById(match.teamA);
        const teamB = await Team.findById(match.teamB);

        if (!teamA.discordRoleId || !teamB.discordRoleId) {
            console.log(`Cannot create channel for Match ${match.matchNumber}: Missing roles`);
            return;
        }

        const channelName = `match-${match.matchNumber}-${teamA.shortName}-vs-${teamB.shortName}`.toLowerCase();

        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: DISCORD_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id, // @everyone
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamA.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                },
                {
                    id: teamB.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
                },
                // Add Admin Role ID here if needed
            ],
        });

        // [NEW] Create Voice Channel for Team A
        await guild.channels.create({
            name: `🔊 ${teamA.shortName} (M${match.matchNumber})`,
            type: ChannelType.GuildVoice,
            parent: DISCORD_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamA.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
                },
            ],
        });

        // [NEW] Create Voice Channel for Team B
        await guild.channels.create({
            name: `🔊 ${teamB.shortName} (M${match.matchNumber})`,
            type: ChannelType.GuildVoice,
            parent: DISCORD_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamB.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
                },
            ],
        });

        match.discordChannelId = channel.id;
        await match.save();

        channel.send(`**MATCH READY**\n<@&${teamA.discordRoleId}> vs <@&${teamB.discordRoleId}>\nScheduled for: <t:${Math.floor(new Date(match.scheduledTime).getTime() / 1000)}:F>`);

    } catch (e) {
        console.error("Error creating match channel:", e);
    }
}

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

// --- [NEW] FILENAME GENERATOR ---
const generateUploadFilename = async (req, file) => {
    const originalExt = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    let prefix = 'upload';

    try {
        const routePath = req.route ? req.route.path : '';

        // Team registration
        if (routePath === '/api/register') {
            // req.body is not reliably available here, so we use a generic name
            prefix = `team-registration-logo`;
        }
        // Team logo update
        else if (routePath === '/api/teams/logo') {
            const team = await Team.findById(req.user.id).select('shortName');
            const shortName = team ? team.shortName.replace(/[^a-z0-9-]/gi, '_').toLowerCase() : req.user.id;
            prefix = `team-${shortName}-logo`;
        }
        // Match related uploads
        else if (req.params.id) {
            const match = await Match.findById(req.params.id).select('matchNumber');
            const matchNum = match ? String(match.matchNumber).padStart(3, '0') : req.params.id;

            if (routePath === '/api/matches/:id/submit-score') {
                // file.fieldname is like 'proof_0', 'proof_1'
                const mapIndex = file.fieldname.split('_')[1] || '0';
                prefix = `match-${matchNum}-score-map${mapIndex}`;
            } else if (routePath === '/api/matches/:id/claim-forfeit') {
                prefix = `match-${matchNum}-forfeit-proof`;
            }
        }
    } catch (e) {
        console.error('Error generating filename:', e);
        prefix = 'generic-upload';
    }

    // Sanitize prefix
    prefix = prefix.replace(/ /g, '-');

    return `${prefix}-${timestamp}${originalExt}`;
};

// --- [NEW] IMGBB CUSTOM STORAGE ENGINE ---
function ImgbbStorage(opts) {
    this.apiKey = opts.apiKey;
}

ImgbbStorage.prototype._handleFile = function _handleFile(req, file, cb) {
    if (!this.apiKey) {
        return cb(new Error('IMGBB API key is missing.'));
    }

    const stream = file.stream;
    const chunks = [];
    stream.on('data', (chunk) => {
        chunks.push(chunk);
    });

    stream.on('error', (err) => {
        cb(err);
    });

    stream.on('end', async () => {
        try {
            const buffer = Buffer.concat(chunks);
            const base64string = buffer.toString('base64');

            const filename = await generateUploadFilename(req, file);

            const response = await imgbbUploader({
                apiKey: this.apiKey,
                base64string: base64string,
                name: filename,
            });

            cb(null, { path: response.url, size: response.size, filename: response.image.filename });
        } catch (error) {
            cb(error);
        }
    });
};

ImgbbStorage.prototype._removeFile = function _removeFile(req, file, cb) {
    // imgbb free API does not support deletion, so we just callback
    cb(null);
};

// --- [NEW] Custom Local Disk Storage with Async Filename ---
function CustomLocalDiskStorage(opts) {
    this.getDestination = opts.destination;
    this.getFilename = opts.filename;
}
CustomLocalDiskStorage.prototype._handleFile = function _handleFile(req, file, cb) {
    this.getDestination(req, file, (err, destination) => {
        if (err) return cb(err);
        this.getFilename(req, file, (err, filename) => {
            if (err) return cb(err);

            const finalPath = path.join(destination, filename);
            const outStream = fs.createWriteStream(finalPath);

            file.stream.pipe(outStream);
            outStream.on('error', cb);
            outStream.on('finish', () => {
                cb(null, {
                    destination: destination,
                    filename: filename,
                    path: finalPath,
                    size: outStream.bytesWritten
                });
            });
        });
    });
};
CustomLocalDiskStorage.prototype._removeFile = function _removeFile(req, file, cb) {
    fs.unlink(file.path, cb);
};

// --- [UPDATED] STORAGE CONFIGURATION (Cloudinary vs Local) ---
let upload;
if (process.env.IMGBB_API_KEY) {
    if (!imgbbUploader) {
        console.error("❌ Error: IMGBB_API_KEY is set but 'imgbb-uploader' is not installed.\nPlease run: npm install imgbb-uploader");
        process.exit(1);
    }
    // Use Imgbb
    const imgbbStorage = new ImgbbStorage({
        apiKey: process.env.IMGBB_API_KEY,
    });
    upload = multer({
        storage: imgbbStorage,
        limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
        fileFilter: (req, file, cb) => {
            if (file.mimetype.startsWith('image/')) cb(null, true);
            else cb(new Error('Only images allowed'), false);
        }
    });
    console.log("🖼️  Storage: Using Imgbb");
} else if (process.env.CLOUDINARY_URL) {
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
            public_id: async (req, file) => {
                const filename = await generateUploadFilename(req, file);
                return path.parse(filename).name; // Cloudinary adds extension
            }
        },
    });
    upload = multer({ storage: cloudStorage });
    console.log("☁️  Storage: Using Cloudinary");
} else {
    // ใช้ Local Disk (สำหรับ Development)
    const storage = new CustomLocalDiskStorage({
        destination: (req, file, cb) => {
            const dir = 'public/uploads';
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            generateUploadFilename(req, file)
                .then(filename => cb(null, filename))
                .catch(err => cb(err));
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

// --- CRON JOB: MATCH NOTIFICATIONS (10 Minutes Before) ---
cron.schedule('* * * * *', async () => {
    try {
        const now = new Date();
        const tenMinutesFromNow = new Date(now.getTime() + 10 * 60000);
        const elevenMinutesFromNow = new Date(now.getTime() + 11 * 60000);

        const matches = await Match.find({
            status: 'scheduled',
            notificationSent: false,
            discordChannelId: { $exists: true, $ne: null },
            scheduledTime: { $gte: now, $lte: elevenMinutesFromNow } // Check matches starting in ~10 mins
        }).populate('teamA teamB');

        for (const m of matches) {
            const channel = await discordClient.channels.fetch(m.discordChannelId).catch(() => null);
            if (channel) {
                const roleA = m.teamA.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : m.teamA.name;
                const roleB = m.teamB.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : m.teamB.name;
                await channel.send(`🚨 **10 MINUTES REMAINING** 🚨\n${roleA} and ${roleB}, please prepare for your match! Check-in is open.`);
                m.notificationSent = true;
                await m.save();
            }
        }
    } catch (e) { console.error("Notification Cron Error:", e); }
});

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
    } catch (e) { console.error("Log Error:", e); }
}

// --- AUTH & TEAMS ROUTES ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password, role } = req.body;

        // แปลง input ให้เป็นตัวพิมพ์เล็กเพื่อความแม่นยำ
        const cleanUsername = username.toLowerCase().trim();

        if (role === 'admin') {
            const u = await User.findOne({ username: cleanUsername });
            if (!u || !bcrypt.compareSync(password, u.password)) return res.status(400).json({ msg: 'Invalid Credentials' });
            return res.json({ token: jwt.sign({ id: u._id, role: 'admin' }, process.env.JWT_SECRET), role: 'admin' });
        }

        // ค้นหา Team ด้วย username
        const t = await Team.findOne({ username: cleanUsername });

        if (!t || !bcrypt.compareSync(password, t.password)) return res.status(400).json({ msg: 'Invalid Credentials' });
        if (t.status !== 'approved') return res.status(403).json({ msg: 'Team account not approved yet' });

        // Payload ส่ง name (Display Name) ไปแสดงผล แต่ id ยังคงเดิม
        res.json({ token: jwt.sign({ id: t._id, role: 'team', name: t.name }, process.env.JWT_SECRET), role: 'team', id: t._id });
    } catch (e) { res.status(500).json({ msg: 'Server Error' }); }
});
// [UPDATED] Register using Cloudinary-aware upload
app.post('/api/register', upload.single('logo'), async (req, res) => {
    try {
        // รับ username เพิ่มเข้ามา
        const { username, name, shortName, password } = req.body;
        const cleanUsername = username.toLowerCase().trim();

        const logo = req.file ? getFileUrl(req.file) : DEFAULT_LOGO;

        // Check 1: Username ซ้ำไหม?
        const existingUser = await Team.findOne({ username: cleanUsername });
        if (existingUser) return res.status(400).json({ msg: 'Username is already taken' });

        // Check 2: Team Name (Display Name) ซ้ำไหม? (ยังควรเช็คเพื่อไม่ให้สับสนในการแข่ง)
        const existingName = await Team.findOne({ name: name });
        if (existingName) return res.status(400).json({ msg: 'Team Name is already registered' });

        await new Team({
            username: cleanUsername,
            name,
            shortName,
            password: bcrypt.hashSync(password, 10),
            logo,
            status: 'pending'
        }).save();

        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.post('/api/teams/:id/approve', auth(['admin']), async (req, res) => { await Team.findByIdAndUpdate(req.params.id, { status: 'approved' }); res.json({ success: true }); });
app.delete('/api/teams/:id', auth(['admin']), async (req, res) => { await Team.findByIdAndDelete(req.params.id); res.json({ success: true }); });
app.get('/api/teams', async (_, res) => res.json(await Team.find()));
app.get('/api/teams/me', auth(['team']), async (req, res) => res.json(await Team.findById(req.user.id)));

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
            const addMember = (nameCol, tagCol, discordCol, role) => {
                if (!nameCol) return;
                let mName = nameCol.trim();
                let mTag = tagCol ? tagCol.trim().replace('#', '') : '0000';
                let mDiscord = discordCol ? discordCol.trim() : '';

                // Fallback: Support Name#Tag in name column if tag column is empty
                if (mName.includes('#') && mTag === '0000') {
                    const parts = mName.split('#');
                    mName = parts[0].trim();
                    mTag = parts[1].trim();
                }

                if (mName) members.push({ role, name: mName, tag: mTag, discordName: mDiscord, status: 'approved' });
            };

            // Mains (5 players): Cols 4,5,6 | 7,8,9 ...
            for (let i = 0; i < 5; i++) { const idx = 4 + (i * 3); addMember(cols[idx], cols[idx + 1], cols[idx + 2], 'Main'); }
            // Subs (2 players): Cols 19,20,21 | 22,23,24
            for (let i = 0; i < 2; i++) { const idx = 19 + (i * 3); addMember(cols[idx], cols[idx + 1], cols[idx + 2], 'Sub'); }
            // Coach: Cols 25,26,27
            addMember(cols[25], cols[26], cols[27], 'Coach');

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

// [NEW] Import Discord IDs from CSV
app.post('/api/admin/discord/import', auth(['admin']), csvUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ msg: 'No file uploaded' });

        const fileContent = req.file.buffer.toString('utf8');
        const lines = fileContent.split(/\r?\n/);
        let updated = 0, errors = 0;

        // Expected CSV Format: TeamName, PlayerName, DiscordID
        for (let i = 1; i < lines.length; i++) { // Skip header
            const line = lines[i].trim();
            if (!line) continue;

            const [teamName, playerName, discordId] = line.split(',').map(s => s.trim());

            if (teamName && playerName && discordId) {
                const team = await Team.findOne({ name: new RegExp(`^${teamName}$`, 'i') });
                if (team) {
                    const member = team.members.find(m => m.name.toLowerCase() === playerName.toLowerCase());
                    if (member) {
                        member.discordId = discordId;
                        await team.save();
                        updated++;
                    } else { errors++; }
                } else { errors++; }
            }
        }

        await logAdminAction(req, 'IMPORT_DISCORD', 'CSV Import', { updated, errors });
        res.json({ success: true, msg: `Updated ${updated} players. ${errors} failed.` });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Send Claim Role Button
app.post('/api/admin/discord/send-claim', auth(['admin']), async (req, res) => {
    try {
        if (!DISCORD_CLAIM_CHANNEL_ID) return res.status(400).json({ msg: 'Channel ID not configured' });

        const channel = await discordClient.channels.fetch(DISCORD_CLAIM_CHANNEL_ID);
        if (!channel) return res.status(404).json({ msg: 'Channel not found' });

        const embed = new EmbedBuilder()
            .setColor(0xff4655)
            .setTitle('🛡️ TOURNAMENT ROLE CLAIM')
            .setDescription('Click the button below to verify your registration and claim your Team Role.\nEnsure your Discord ID matches the one provided to the admins.')
            .setFooter({ text: 'VCT System' });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('claim_role')
                    .setLabel('Claim Team Role')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔐')
            );

        await channel.send({ embeds: [embed], components: [row] });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Sync Team Role (Create/Update Discord Role)
app.post('/api/teams/:id/discord/sync-role', auth(['admin']), async (req, res) => {
    try {
        const team = await Team.findById(req.params.id);
        if (!team) return res.status(404).json({ msg: 'Team not found' });

        if (!DISCORD_GUILD_ID) return res.status(500).json({ msg: 'Discord Guild ID not configured' });

        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID).catch(() => null);
        if (!guild) return res.status(500).json({ msg: 'Discord Guild not found (Check Bot)' });

        let role;
        if (team.discordRoleId) {
            role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
        }

        if (!role) {
            // Create Role
            try {
                role = await guild.roles.create({
                    name: team.name,
                    color: '#ff4655',
                    reason: `Tournament Team Role for ${team.name}`
                });
            } catch (err) {
                return res.status(500).json({ msg: 'Failed to create role: ' + err.message });
            }
            team.discordRoleId = role.id;
            await team.save();
        } else {
            // Update Role Name if changed
            if (role.name !== team.name) {
                await role.edit({ name: team.name }).catch(e => console.log("Role update failed", e));
            }
        }

        res.json({ success: true, roleId: role.id, roleName: role.name });
    } catch (e) {
        console.error(e);
        res.status(500).json({ msg: e.message });
    }
});

// Roster Management
app.put('/api/teams/roster', auth(['team']), async (req, res) => {
    try {
        const team = await Team.findById(req.user.id);
        const newMembers = req.body.members;

        if (!team.rosterLocked) {
            team.members = newMembers.map(m => ({ ...m, status: 'approved', pendingUpdate: null }));
            team.rosterLocked = true;
            await team.save();
            return res.json({ success: true, msg: 'Roster initialized.' });
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
                    discordId: incoming.discordId,
                    discordName: incoming.discordName,
                    status: 'pending',
                    pendingUpdate: { name: incoming.name, tag: incoming.tag }
                });
            } else if (existing) {
                if (incoming) {
                    existing.role = incoming.role;

                    existing.discordName = incoming.discordName;

                }
                updatedMembers.push(existing);
            }
        }
        team.members = updatedMembers;
        await team.save();
        io.emit('teams_update');
        res.json({ success: true, msg: 'Changes submitted for approval.' });
    } catch (e) { res.status(500).json({ msg: 'Server Error' }); }
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

app.put('/api/teams/:id/members/:mid/status', auth(['admin']), async (req, res) => {
    try {
        const { status } = req.body;
        const team = await Team.findById(req.params.id);
        const member = team.members.id(req.params.mid);

        if (member) {
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
            res.json({ success: true });
        } else {
            res.status(404).json({ msg: 'Member not found' });
        }
    } catch (e) { res.status(500).json(e); }
});

app.put('/api/teams/:id/members/:mid/edit', auth(['admin']), async (req, res) => {
    try {
        const { tag } = req.body;
        const team = await Team.findById(req.params.id);
        const member = team.members.id(req.params.mid);

        if (member) {
            member.tag = tag;
            await team.save();
            io.emit('teams_update');
            res.json({ success: true });
        } else {
            res.status(404).json({ msg: 'Member not found' });
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ msg: 'Server Error' });
    }
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
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// --- MATCH ROUTES ---

app.get('/api/matches', async (_, res) => {
    try {
        const matches = await Match.find()
            .populate({ path: 'teamA', populate: { path: 'members' } })
            .populate({ path: 'teamB', populate: { path: 'members' } })
            .populate('winner')
            .populate('tournament');

        const matchesWithPresence = matches.map(m => {
            const obj = m.toObject();
            obj.presence = vetoMgr.presence[m._id.toString()] || {};
            return obj;
        });
        res.json(matchesWithPresence);
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

// [NEW] Public Overlay Endpoint
app.get('/api/overlay/match/:id', async (req, res) => {
    try {
        const match = await Match.findById(req.params.id)
            .populate('teamA', 'name shortName logo')
            .populate('teamB', 'name shortName logo')
            .populate('tournament', 'name')
            .populate('vetoData.pickedMaps.pickedBy', 'shortName');

        if (!match) return res.status(404).json({ msg: 'Match not found' });

        let seriesA = 0, seriesB = 0;
        const mapScores = match.scores || [];

        // Calculate Series Score
        if (match.status === 'finished') {
            mapScores.forEach(s => {
                const sA = parseInt(s.teamAScore) || 0;
                const sB = parseInt(s.teamBScore) || 0;
                if (sA > sB) seriesA++;
                else if (sB > sA) seriesB++;
            });
        } else {
            // For live matches, only count completed maps (heuristic: >= 13 and diff >= 2)
            mapScores.forEach(s => {
                const sA = parseInt(s.teamAScore) || 0;
                const sB = parseInt(s.teamBScore) || 0;
                if ((sA >= 13 && sA >= sB + 2) || (sA > 12 && sB > 12 && sA > sB + 1)) seriesA++;
                else if ((sB >= 13 && sB >= sA + 2) || (sB > 12 && sA > 12 && sB > sA + 1)) seriesB++;
            });
        }

        // Determine Current Map
        let currentMap = null;
        if (match.status === 'live' && match.vetoData && match.vetoData.pickedMaps) {
            const lastScore = mapScores[mapScores.length - 1];
            let lastMapFinished = false;
            if (lastScore) {
                const sA = parseInt(lastScore.teamAScore) || 0;
                const sB = parseInt(lastScore.teamBScore) || 0;
                if ((sA >= 13 && sA >= sB + 2) || (sB >= 13 && sB >= sA + 2) || (sA > 12 && sB > 12 && Math.abs(sA - sB) >= 2)) lastMapFinished = true;
            }

            let mapIndex = lastMapFinished ? mapScores.length : Math.max(0, mapScores.length - 1);
            if (match.vetoData.pickedMaps[mapIndex]) {
                currentMap = match.vetoData.pickedMaps[mapIndex].map;
            }
        }

        res.json({
            matchId: match._id,
            tournament: match.tournament ? match.tournament.name : '',
            stage: match.name,
            format: match.format,
            status: match.status,
            teamA: { id: match.teamA?._id, name: match.teamA?.name || 'TBD', shortName: match.teamA?.shortName || 'TBD', logo: match.teamA?.logo || '', seriesScore: seriesA },
            teamB: { id: match.teamB?._id, name: match.teamB?.name || 'TBD', shortName: match.teamB?.shortName || 'TBD', logo: match.teamB?.logo || '', seriesScore: seriesB },
            currentMap: currentMap,
            scores: mapScores,
            veto: {
                bans: match.vetoData?.bannedMaps || [],
                picks: match.vetoData?.pickedMaps || [],
                sequence: match.vetoData?.sequence || [],
                status: match.vetoData?.status,
                startTime: match.vetoData?.currentTurnStartTime,
                deadline: match.vetoData?.currentTurnDeadline,
                teamAReady: match.vetoData?.teamAReady,
                teamBReady: match.vetoData?.teamBReady,
                coinTossWinner: match.vetoData?.coinTossWinner
            },
            presence: vetoMgr.presence[match._id.toString()] || {}
        });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.delete('/api/matches/:id', auth(['admin']), async (req, res) => {
    try {
        await Match.findByIdAndDelete(req.params.id);
        await Tournament.updateMany({ "stages.matches": req.params.id }, { $pull: { "stages.$[].matches": req.params.id } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

app.put('/api/matches/:id', auth(['admin']), async (req, res) => {
    try {
        const { format, name, status, scheduledTime } = req.body;
        const update = {};
        if (format) update.format = format;
        if (name) update.name = name;
        if (status) update.status = status;
        if (scheduledTime !== undefined) update.scheduledTime = scheduledTime;

        const match = await Match.findByIdAndUpdate(req.params.id, update, { new: true });
        io.emit('match_update', match);

        // [NEW] Notify Teams on Schedule Change
        if (scheduledTime !== undefined) {
            const msg = `Match ${match.name} time updated: ${new Date(scheduledTime).toLocaleString()}`;
            if (match.teamA) io.to(match.teamA.toString()).emit('notification', { msg });
            if (match.teamB) io.to(match.teamB.toString()).emit('notification', { msg });
        }

        // [NEW] Create Discord Channel if scheduled
        if (scheduledTime && match.teamA && match.teamB) {
            createMatchChannel(match);
        }

        res.json({ success: true, match });
    } catch (e) { res.status(500).json(e); }
});

// [NEW] Swap Teams Endpoint (Drag & Drop)
app.post('/api/matches/swap-teams', auth(['admin']), async (req, res) => {
    try {
        const { match1Id, slot1, match2Id, slot2 } = req.body;

        let m1 = await Match.findById(match1Id);
        let m2 = (match1Id === match2Id) ? m1 : await Match.findById(match2Id);

        if (!m1 || !m2) return res.status(404).json({ msg: 'Match not found' });
        if (m1.status === 'finished' || m2.status === 'finished') return res.status(400).json({ msg: 'Cannot swap finished matches' });

        const team1Id = m1[slot1];
        const team2Id = m2[slot2];

        // Swap Teams
        m1[slot1] = team2Id;
        m2[slot2] = team1Id;

        // Update Rosters
        const getRoster = async (tid) => {
            if (!tid) return [];
            const t = await Team.findById(tid);
            return t ? t.members : [];
        };

        m1[`${slot1}Roster`] = await getRoster(team2Id);
        m2[`${slot2}Roster`] = await getRoster(team1Id);

        await m1.save();
        if (m1._id.toString() !== m2._id.toString()) await m2.save();

        await logAdminAction(req, 'SWAP_TEAMS', `Swapped ${slot1} of Match ${m1.matchNumber} with ${slot2} of Match ${m2.matchNumber}`, {});

        io.emit('match_update', m1);
        if (m1._id.toString() !== m2._id.toString()) io.emit('match_update', m2);
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
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        let scores = JSON.parse(req.body.scores);
        req.files.forEach(file => {
            const parts = file.fieldname.split('_');
            if (parts.length === 2 && parts[0] === 'proof') {
                const index = parseInt(parts[1]);
                if (scores[index]) {
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
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Claim Forfeit (Team) - [UPDATED] Uses upload (Cloudinary/Local)
app.post('/api/matches/:id/claim-forfeit', auth(['team']), upload.single('proof'), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB');
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.status === 'finished') return res.status(400).json({ msg: 'Match already finished' });

        if (!match.scheduledTime) return res.status(400).json({ msg: 'Match has no scheduled time' });
        const diffMinutes = (new Date() - new Date(match.scheduledTime)) / 1000 / 60;

        if (diffMinutes < 15) return res.status(400).json({ msg: `Wait at least 15 minutes after schedule time` });
        if (!req.file) return res.status(400).json({ msg: 'Proof screenshot is required' });

        const isTeamA = match.teamA._id.toString() === req.user.id;
        const mapCount = match.format === 'BO1' ? 1 : (match.format === 'BO3' ? 2 : 3);
        const forfeitScores = [];

        for (let i = 0; i < mapCount; i++) {
            forfeitScores.push({
                mapName: `Forfeit Map ${i + 1}`,
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
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Admin Edit Pending Score Submission
app.put('/api/matches/:id/submission/edit', auth(['admin']), async (req, res) => {
    try {
        const { mapIndex, teamAScore, teamBScore } = req.body;
        const match = await Match.findById(req.params.id);

        if (!match || match.status !== 'pending_approval') {
            return res.status(400).json({ msg: 'Match is not in a pending approval state.' });
        }

        if (match.scoreSubmission.tempScores[mapIndex]) {
            match.scoreSubmission.tempScores[mapIndex].teamAScore = teamAScore;
            match.scoreSubmission.tempScores[mapIndex].teamBScore = teamBScore;

            match.markModified('scoreSubmission.tempScores'); // Tell Mongoose the array was changed

            await match.save();
            await logAdminAction(req, 'EDIT_PENDING_SCORE', `Match ${match.matchNumber}`, { mapIndex, teamAScore, teamBScore });

            io.emit('match_update', match);
            res.json({ success: true, match });
        } else {
            res.status(404).json({ msg: 'Map index not found in submission.' });
        }
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// Approve Score (Admin)
app.post('/api/matches/:id/approve-score', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id).populate('teamA teamB nextMatchId loserMatchId');
        if (!match) return res.status(404).json({ msg: 'Not found' });

        match.scores = match.scoreSubmission.tempScores;
        let wA = 0, wB = 0;
        match.scores.forEach(s => {
            if (parseInt(s.teamAScore) > parseInt(s.teamBScore)) wA++;
            else if (parseInt(s.teamBScore) > parseInt(s.teamAScore)) wB++;
        });

        const winner = wA > wB ? match.teamA : match.teamB;
        const loser = wA > wB ? match.teamB : match.teamA;

        match.winner = winner;
        match.status = 'finished';
        if (match.scoreSubmission.rejectReason === 'FORFEIT CLAIM') match.name += " (Forfeit)";
        match.scoreSubmission.status = 'approved';
        await match.save();

        await Team.findByIdAndUpdate(winner._id, { $inc: { wins: 1 } });
        await Team.findByIdAndUpdate(loser._id, { $inc: { losses: 1 } });

        await BracketManager.propagateMatchResult(match, winner, loser);

        await logAdminAction(req, 'APPROVE_SCORE', `Match ${match.matchNumber} (${match.name})`, { winner: winner.name });

        io.emit('match_update', match);
        io.emit('bracket_update');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
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
        if (!match) return res.status(404).json({ msg: 'Match not found' });

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
    } catch (e) {
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
    } catch (e) { res.status(500).json(e); }
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

        // [NEW] Notify Opponent
        const opponentId = match.teamA.toString() === req.user.id ? match.teamB.toString() : match.teamA.toString();
        io.to(opponentId).emit('notification', { msg: `Reschedule Request received for ${match.name}` });

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

        const requester = match.rescheduleRequest.requestedBy;

        if (action === 'accept') {
            match.scheduledTime = match.rescheduleRequest.proposedTime;
            match.checkIn = { teamA: false, teamB: false, windowOpen: false }; // Reset check-in
        }
        match.rescheduleRequest = { status: 'none' }; // Clear request
        await match.save();
        io.emit('match_update', match);

        // [NEW] Notify Requester
        if (requester) {
            const msg = action === 'accept' ? `Reschedule ACCEPTED for ${match.name}` : `Reschedule REJECTED for ${match.name}`;
            io.to(requester.toString()).emit('notification', { msg });
        }

        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Pause Request
app.post('/api/matches/:id/pause', auth(['team']), async (req, res) => {
    try {
        const { reason } = req.body;
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        if (match.teamA.toString() !== req.user.id && match.teamB.toString() !== req.user.id) {
            return res.status(403).json({ msg: 'Unauthorized' });
        }

        const isVetoLive = match.status === 'scheduled' && match.vetoData && match.vetoData.status === 'in_progress';
        if (match.status !== 'live' && !isVetoLive) return res.status(400).json({ msg: 'Match is not live or in veto' });

        if (isVetoLive) {
            const result = await vetoMgr.handleTeamPause(req.params.id, req.user.id);
            if (!result.success) return res.status(400).json({ msg: result.msg });
            return res.json({ success: true });
        }

        match.pauseRequest = {
            requestedBy: req.user.id,
            reason: reason || 'Technical Issue',
            status: 'pending',
            timestamp: new Date()
        };
        await match.save();

        io.emit('match_update', match);
        io.emit('notification', { msg: `⚠️ PAUSE REQUESTED: ${match.name}`, type: 'error' });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Resume Match (Team)
app.post('/api/matches/:id/resume', auth(['team']), async (req, res) => {
    try {
        const result = await vetoMgr.handleTeamResume(req.params.id, req.user.id);
        if (!result.success) return res.status(400).json({ msg: result.msg });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Admin Pause Veto
app.post('/api/matches/:id/admin-pause', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        if (match.vetoData && match.vetoData.status === 'in_progress') {
            await vetoMgr.adminPause(match);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Resolve Pause (Admin)
app.post('/api/matches/:id/pause/resolve', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });

        match.pauseRequest.status = 'resolved';

        if (match.status === 'scheduled' && match.vetoData && match.vetoData.status === 'paused') {
            match.vetoData.status = 'in_progress';
            match.vetoData.pausedBy = null;
            await vetoMgr.logAction(match, "RESUME: Admin resolved pause");
            await match.save();
            await vetoMgr.resumeTimer(match);
        } else {
            await match.save();
        }

        io.emit('match_update', match);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Admin Reset Veto Timer
app.post('/api/matches/:id/reset-timer', auth(['admin']), async (req, res) => {
    try {
        const match = await Match.findById(req.params.id);
        if (!match) return res.status(404).json({ msg: 'Match not found' });
        await vetoMgr.resetTurnTimer(match);
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
        const { name, mapPool, prizePool, formatDescription } = req.body;
        const update = { name, mapPool };
        if (prizePool !== undefined) update.prizePool = prizePool;
        if (formatDescription !== undefined) update.formatDescription = formatDescription;
        await Tournament.findByIdAndUpdate(req.params.id, update);
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
                groupWinners.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));
                groupRunnersUp.sort((a, b) => getGroupChar(a.match.name).localeCompare(getGroupChar(b.match.name)));

                finalParticipants = [
                    ...groupWinners.map(x => x.team),
                    ...groupRunnersUp.map(x => x.team)
                ];

                const teamsDb = await Team.find({ _id: { $in: finalParticipants } });
                finalParticipants = finalParticipants.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);

            }
            // --- CASE B: From League/Swiss (Top N) ---
            else if (['round_robin', 'swiss'].includes(sourceStage.type)) {
                const standings = await BracketManager.getStageStandings(tournament._id, settings.sourceStageIndex);

                // Grouping Logic
                const grouped = {};
                standings.forEach(s => {
                    const g = s.group || 'A';
                    if (!grouped[g]) grouped[g] = [];
                    grouped[g].push(s);
                });

                const count = settings.advanceCount || 2;
                const selectedIds = [];

                Object.keys(grouped).sort().forEach(g => {
                    const top = grouped[g].slice(0, count);
                    selectedIds.push(...top.map(s => s.id));
                });

                const teamsDb = await Team.find({ _id: { $in: selectedIds } });
                finalParticipants = selectedIds.map(id => teamsDb.find(t => t._id.toString() === id.toString())).filter(t => t);
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

    } catch (e) {
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

// [NEW] Update Stage Settings (e.g. Tiebreakers)
app.put('/api/tournaments/:id/stages/:stageIndex/settings', auth(['admin']), async (req, res) => {
    try {
        const { settings } = req.body;
        const tournament = await Tournament.findById(req.params.id);
        if (!tournament || !tournament.stages[req.params.stageIndex]) return res.status(404).json({ msg: 'Stage not found' });

        tournament.stages[req.params.stageIndex].settings = {
            ...tournament.stages[req.params.stageIndex].settings,
            ...settings
        };

        await tournament.save();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Add Team to Stage (Round Robin / Cross Group)
app.post('/api/tournaments/:id/stages/:stageIndex/teams/add', auth(['admin']), async (req, res) => {
    try {
        const { teamId, groupIndex } = req.body;
        await BracketManager.addTeamToStage(req.params.id, req.params.stageIndex, teamId, groupIndex);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
});

// [NEW] Swap Teams in Stage
app.post('/api/tournaments/:id/stages/:stageIndex/teams/swap', auth(['admin']), async (req, res) => {
    try {
        const { team1Id, team2Id } = req.body;
        await BracketManager.swapTeamsInStage(req.params.id, req.params.stageIndex, team1Id, team2Id);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ msg: e.message }); }
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
    socket.on('join_admin', () => { socket.join('admins'); });
    socket.on('join_match', (data) => {
        const matchId = typeof data === 'object' ? data.matchId : data;
        const teamId = typeof data === 'object' ? data.teamId : null;
        socket.join(matchId);
        if (teamId) {
            socket.matchId = matchId;
            socket.teamId = teamId;
            vetoMgr.handleConnection(matchId, teamId);
        } else {
            vetoMgr.broadcastState(matchId);
        }
    });
    socket.on('update_status', (status) => {
        if (socket.matchId && socket.teamId) vetoMgr.handleStatusUpdate(socket.matchId, socket.teamId, status);
    });
    socket.on('disconnect', () => {
        if (socket.matchId && socket.teamId) vetoMgr.handleDisconnection(socket.matchId, socket.teamId);
    });
    socket.on('join_team_room', (teamId) => { socket.join(teamId); });
    socket.on('set_room_pass', (d) => vetoMgr.handleSetRoomPass(d.matchId, d.teamId, d.password));
    socket.on('send_chat', (d) => vetoMgr.handleChat(d.matchId, d.teamId, d.message));
    socket.on('team_ready', (d) => vetoMgr.handleReady(d.matchId, d.teamId));
    socket.on('decision_made', (d) => vetoMgr.handleDecision(d.matchId, d.teamId, d.choice));
    socket.on('veto_action', (d) => vetoMgr.handleAction(d.matchId, d.teamId, d.action, d.map, d.side));
});

server.listen(process.env.PORT || 3000, () => console.log('🚀 Server Running...'));