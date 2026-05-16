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
const csv = require('csv-parser');
// [ADDED] Libraries for Production
const helmet = require('helmet');
const compression = require('compression');

const logger = require('./utils/logger'); // [NEW] Winston Logger

// Import Managers
const VetoManager = require('./managers/vetoManager');
const BracketManager = require('./managers/bracketManager');

// Import Models
const Match = require('./models/Match');
const Team = require('./models/Team');

// Import Services
const discordService = require('./services/discordService');
const queueService = require('./services/queueService');
const discordBot = require('./services/discordBot');

const app = express();
const server = http.createServer(app);

// [FIX] Initialize Socket.IO (Missing in previous code)
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins (adjust for production)
        methods: ["GET", "POST"]
    }
});

// Export IO for services to use
module.exports.getIO = () => io;

app.use(cors()); // Basic CORS
// [ADDED] Security & Compression
app.use(helmet({
    contentSecurityPolicy: false, // ปิด CSP ชั่วคราวเพื่อให้โหลดรูปจากเว็บนอกได้ (เช่น valorant-api, cloudinary)
    crossOriginEmbedderPolicy: false
}));
app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- [NEW] ROUTES IMPORT ---
const teamRoutes = require('./routes/teamRoutes');
const matchRoutes = require('./routes/matchRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
const discordRoutes = require('./routes/discordRoutes');
const adminRoutes = require('./routes/adminRoutes');
const overlayRoutes = require('./routes/overlayRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const statsRoutes = require('./routes/statsRoutes');

app.use('/api', teamRoutes);
app.use('/api', matchRoutes);
app.use('/api', tournamentRoutes);
app.use('/api', discordRoutes);
app.use('/api', adminRoutes);
app.use('/api', overlayRoutes);
app.use('/api', notificationRoutes);
app.use('/api', statsRoutes);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// --- MANAGERS INITIALIZATION ---
// สร้าง Manager ก่อน Connect DB เพื่อให้พร้อมเรียกใช้ restoreTimers
const vetoMgr = new VetoManager(io);
BracketManager.setIO(io);
BracketManager.onMatchReady = discordService.createMatchChannel.bind(discordService); // [NEW] Hook up channel creation for next matches

// Share VetoManager
app.set('vetoMgr', vetoMgr);
discordBot.init(vetoMgr);

// [FIX] Share IO, Discord Client, and Helper Functions with Routes
app.set('io', io);
app.set('discordClient', discordBot.client);
app.set('createMatchChannel', discordService.createMatchChannel.bind(discordService)); // Use local queued function
app.set('deleteMatchChannels', discordService.deleteMatchChannels.bind(discordService));
app.set('deleteMatchVoiceChannels', discordService.deleteMatchVoiceChannels.bind(discordService));
app.set('sendMatchResultToDiscord', discordService.sendMatchResultToDiscord.bind(discordService));
app.set('updateMatchTime', discordService.updateMatchTime.bind(discordService));
app.set('sendBracketAnnouncement', discordService.sendBracketAnnouncement.bind(discordService));

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney')
    .then(async () => {
        logger.info('✅ MongoDB Connected');

        // [ADDED] กู้คืน Timer ของ Veto กรณี Server รีสตาร์ท
        if (vetoMgr.restoreTimers) {
            await vetoMgr.restoreTimers();
            logger.info('⏱️  Veto Timers Restored');
        }
        
        // Start Agenda
        await queueService.start();
        logger.info('📅 Agenda Queue Started');

        // [SEED] Create Default Admin if none exists
        const User = require('./models/User');
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const adminUsername = process.env.ADMIN_USERNAME || 'admin';
            const adminPassword = process.env.ADMIN_PASSWORD || 'password123';
            const hashedPassword = bcrypt.hashSync(adminPassword, 10);
            await new User({ 
                username: adminUsername, 
                password: hashedPassword, 
                role: 'admin' 
            }).save();
            logger.info(`👤 Default Admin Created: ${adminUsername} (Password: ${adminPassword})`);
        }
    })
    .catch(err => logger.error('❌ MongoDB Error:', { error: err.message }));


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
    } catch (e) { logger.error("Stats Error:", { error: e.message }); }
    }, 3000);

    app.use((err, req, res, next) => {
    logger.error('❌ [Global Error]:', { error: err.message || err, stack: err.stack, path: req.originalUrl });
    
    const statusCode = err.status || 500;
    const message = process.env.NODE_ENV === 'production' 
        ? 'Internal Server Error' // ซ่อนรายละเอียด error ในโหมด production
        : err.message;

    res.status(statusCode).json({
        success: false,
        error: message
    });
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
    socket.on('priority_report', (d) => vetoMgr.handlePriorityReport(d.matchId, d.teamId, d.winnerId));
    socket.on('send_chat', (d) => vetoMgr.handleChat(d.matchId, d.teamId, d.message));
    socket.on('team_ready', (d) => vetoMgr.handleReady(d.matchId, d.teamId));
    socket.on('decision_made', (d) => vetoMgr.handleDecision(d.matchId, d.teamId, d.choice));
    socket.on('veto_action', (d) => vetoMgr.handleAction(d.matchId, d.teamId, d.action, d.map, d.side));
});

server.listen(process.env.PORT || 3000, () => logger.info(`🚀 Server Running on Port ${process.env.PORT || 3000}...`));
