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

// Import Managers
const VetoManager = require('./managers/vetoManager');
const BracketManager = require('./managers/bracketManager');

// Import Models
const Match = require('./models/Match');
const Team = require('./models/Team');

const app = express();
const server = http.createServer(app);

// [FIX] Initialize Socket.IO (Missing in previous code)
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins (adjust for production)
        methods: ["GET", "POST"]
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
// Note: We use process.env directly for channels to support auto-creation updates

discordClient.once('clientReady', async () => {
    console.log(`🤖 Discord Bot Logged in as ${discordClient.user.tag}`);
    discordClient.user.setActivity('Valorant Comp', { type: 'COMPETING' }); //Set status to "Competing in Valorant Comp"
    await setupDiscordChannels(); // [UPDATED] Auto-create all necessary channels
});

discordClient.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    // [MERGED] Logic from discordBot.js: Team Selection Buttons
    if (interaction.customId.startsWith('team_')) {
        const teamName = interaction.customId.replace('team_', '');
        
        // หมายเหตุ: ตรงนี้ต้องเพิ่ม Logic การหายศ (Role) ในเซิร์ฟเวอร์มาให้ผู้เล่น
        await interaction.reply({ 
            content: `คุณได้ยืนยันตัวตนเข้าสู่ทีม **${teamName}** แล้ว! (ระบบกำลังจ่ายยศให้คุณ)`, 
            ephemeral: true 
        });
        return;
    }

    if (interaction.customId === 'claim_role') {
        await interaction.deferReply({ ephemeral: true });

        try {
            const discordId = interaction.user.id;
            const discordUsername = interaction.user.username;

            // 1. ค้นหาด้วย ID ก่อน (กรณีเคยเคลมแล้ว หรือ Admin ใส่ ID ให้)
            let team = await Team.findOne({ "members.discordId": discordId });
            let member;

            if (team) {
                member = team.members.find(m => m.discordId === discordId);
            } else {
                // 2. ถ้าไม่เจอ ID ให้ค้นหาจากชื่อ Discord (Case Insensitive)
                // ค้นหาทีมที่มี member ชื่อคล้ายกับ username
                const potentialTeams = await Team.find({
                    "members.discordName": { $regex: new RegExp(discordUsername, "i") }
                });

                // วนลูปตรวจสอบความถูกต้อง (รองรับกรณีชื่อใน DB มีหรือไม่มี Tag)
                for (const t of potentialTeams) {
                    const found = t.members.find(m => {
                        if (!m.discordName) return false;
                        const dbName = m.discordName.toLowerCase().trim();
                        const inputName = discordUsername.toLowerCase();
                        // ตรงกันเป๊ะ หรือ ตรงกันแบบตัด Tag (#1234) ออก
                        return dbName === inputName || dbName.split('#')[0] === inputName;
                    });

                    if (found) {
                        team = t;
                        member = found;
                        // บันทึก ID ทันทีเพื่อความแม่นยำในครั้งถัดไป
                        if (!member.discordId) {
                            member.discordId = discordId;
                            await team.save();
                            console.log(`✅ Auto-linked Discord ID for ${discordUsername} to Team ${team.name}`);
                        }
                        break;
                    }
                }
            }

            if (!team || !member) {
                return interaction.editReply({ 
                    content: `❌ ไม่พบข้อมูลผู้เล่นที่ตรงกับ Discord: **${discordUsername}**\n👉 กรุณาไปที่หน้า **Team Dashboard** แล้วระบุชื่อ Discord ของคุณให้ถูกต้อง (ไม่ต้องใส่ #tag)` 
                });
            }

            const guild = interaction.guild;

            // Get or Create Role
            let role;
            if (team.discordRoleId) {
                role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
            }

            // [FIX] Try finding by name to avoid duplicates if ID is missing/invalid
            if (!role) {
                role = guild.roles.cache.find(r => r.name === team.name);
                if (role) {
                    team.discordRoleId = role.id;
                    await team.save();
                }
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

            // Update nickname to "TeamTag | Name"
            const nickname = `${team.shortName} | ${member.name}`;
            await guildMember.setNickname(nickname).catch(e => console.log(`⚠️ Cannot set nickname for ${discordUsername}: ${e.message}`));

            interaction.editReply({ content: `✅ ยืนยันตัวตนสำเร็จ! คุณได้รับยศ **${team.name}** เรียบร้อยแล้ว` });

        } catch (error) {
            console.error("Discord Claim Error:", error);
            interaction.editReply({ content: "⚠️ An error occurred while processing your request." });
        }
    }
});

discordClient.on('messageCreate', async message => {
    if (message.author.bot) return;

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

            // Update nickname to "TeamTag | Name"
            const nickname = `${teamMember.shortName} | ${member.name}`;
            await guildMember.setNickname(nickname).catch(e => console.log(`⚠️ Cannot set nickname for ${message.author.username}: ${e.message}`));

            message.reply(`✅ Verified! You have been assigned the **${teamMember.name}** role.`);
        } catch (e) {
            console.log("❌ There was an error, please contact the admin");
        }
    }

    // [NEW] Admin Command: Delete Category (!deletecategory)
    if (message.content === '!deletecategory') {
        // Check for Administrator permission
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const categoryId = message.channel.parentId;
        if (!categoryId) return message.reply("❌ This channel is not inside a category.");

        const category = message.guild.channels.cache.get(categoryId);
        if (!category) return message.reply("❌ Category not found.");

        await message.reply(`⚠️ **WARNING:** Deleting category **${category.name}** and all channels inside it in 5 seconds...`);

        setTimeout(async () => {
            const channels = message.guild.channels.cache.filter(c => c.parentId === categoryId);
            // Delete all channels in the category
            for (const [_, ch] of channels) {
                await ch.delete().catch(e => console.error(`Failed to delete channel ${ch.name}:`, e.message));
            }
            // Delete the category itself
            await category.delete().catch(e => console.error(`Failed to delete category ${category.name}:`, e.message));
        }, 5000);
    }
});

discordClient.on('guildMemberAdd', async member => {
    try {
        const discordId = member.id;
        const discordUsername = member.user.username;

        // 1. Search by ID first
        let team = await Team.findOne({ "members.discordId": discordId });
        let teamMember;

        if (team) {
            teamMember = team.members.find(m => m.discordId === discordId);
        } else {
            // 2. Search by Username if ID not found
            const potentialTeams = await Team.find({
                "members.discordName": { $regex: new RegExp(discordUsername, "i") }
            });

            for (const t of potentialTeams) {
                const found = t.members.find(m => {
                    if (!m.discordName) return false;
                    const dbName = m.discordName.toLowerCase().trim();
                    const inputName = discordUsername.toLowerCase();
                    return dbName === inputName || dbName.split('#')[0] === inputName;
                });

                if (found) {
                    team = t;
                    teamMember = found;
                    // Auto-link ID
                    if (!teamMember.discordId) {
                        teamMember.discordId = discordId;
                        await team.save();
                        console.log(`✅ Auto-linked Discord ID for ${discordUsername} to Team ${team.name} (Auto-Join)`);
                    }
                    break;
                }
            }
        }

        if (team && teamMember) {
            const guild = member.guild;
            let role;

            if (team.discordRoleId) {
                role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
            }

            if (!role) {
                role = await guild.roles.create({
                    name: team.name,
                    color: '#ff4655',
                    reason: 'Tournament Team Role (Auto-Assign)'
                });
                team.discordRoleId = role.id;
                await team.save();
            }

            await member.roles.add(role);
            
            // Update nickname to "TeamTag | Name"
            const nickname = `${team.shortName} | ${teamMember.name}`;
            await member.setNickname(nickname).catch(e => console.log(`⚠️ Cannot set nickname for ${discordUsername}: ${e.message}`));

            console.log(`✅ Auto-assigned role ${team.name} to ${discordUsername}`);
        }
    } catch (error) {
        console.error("Auto-Assign Role Error:", error);
    }
});

if (process.env.DISCORD_TOKEN) {
    discordClient.login(process.env.DISCORD_TOKEN);
}

// Helper: Create Private Match Channel
async function createMatchChannel(match) {
    if (!match.teamA || !match.teamB) return;
    if (match.discordChannelId) return; // Already created

    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID);
        if (!guild) return;
        if (!DISCORD_GUILD_ID) return console.error("DISCORD_GUILD_ID not set");

        // Ensure roles exist (or fetch them)
        const teamA = await Team.findById(match.teamA);
        const teamB = await Team.findById(match.teamB);

        // [FIX] Auto-create/Find roles if missing to prevent channel creation failure
        async function ensureTeamRole(team) {
            let role;
            if (team.discordRoleId) role = await guild.roles.fetch(team.discordRoleId).catch(() => null);
            
            if (!role) {
                role = guild.roles.cache.find(r => r.name === team.name);
                if (!role) {
                    try {
                        role = await guild.roles.create({ name: team.name, color: '#ff4655', reason: 'Auto-created for Match' });
                    } catch (e) { console.error(`Failed to create role for ${team.name}:`, e.message); }
                }
                if (role) {
                    team.discordRoleId = role.id;
                    await team.save();
                }
            }
        }

        await ensureTeamRole(teamA);
        await ensureTeamRole(teamB);

        if (!teamA.discordRoleId || !teamB.discordRoleId) {
            console.log(`Cannot create channel for Match ${match.matchNumber}: Missing roles`);
            return;
        }

        // [MODIFIED] Create a dedicated Category for this match
        // Use matchNumber if valid, otherwise use ID fragment to avoid "Match 0" duplicates
        const matchIdentifier = (match.matchNumber && match.matchNumber > 0) ? match.matchNumber : match._id.toString().slice(-4);
        const categoryName = `🏆 Match ${matchIdentifier}: ${teamA.shortName} vs ${teamB.shortName}`;
        
        const category = await guild.channels.create({
            name: categoryName,
            type: ChannelType.GuildCategory,
            permissionOverwrites: [
                {
                    id: guild.id, // @everyone
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamA.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect],
                },
                {
                    id: teamB.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect],
                },
            ],
        });

        // Create Text Channel inside Category
        const textChannel = await guild.channels.create({
            name: `💬-match-${matchIdentifier}-chat`,
            type: ChannelType.GuildText,
            parent: category.id,
        });

        // Create Voice Channel for Team A
        await guild.channels.create({
            name: `🔊 ${teamA.shortName} (M${matchIdentifier})`,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamA.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
                },
                {
                    id: teamB.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel], // Allow seeing
                    deny: [PermissionsBitField.Flags.Connect],      // Deny connecting
                }
            ],
        });

        // Create Voice Channel for Team B
        await guild.channels.create({
            name: `🔊 ${teamB.shortName} (M${matchIdentifier})`,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.id,
                    deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                    id: teamB.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak],
                },
                {
                    id: teamA.discordRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel], // Allow seeing
                    deny: [PermissionsBitField.Flags.Connect],      // Deny connecting
                }
            ],
        });

        match.discordChannelId = textChannel.id;
        await match.save();

        const timeStr = match.scheduledTime ? `<t:${Math.floor(new Date(match.scheduledTime).getTime() / 1000)}:F>` : 'TBD';
        textChannel.send(`**MATCH READY**\n<@&${teamA.discordRoleId}> vs <@&${teamB.discordRoleId}>\nScheduled for: ${timeStr}`);

    } catch (e) {
        console.error("Error creating match channel:", e);
    }
}

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

// --- MANAGERS INITIALIZATION ---
// สร้าง Manager ก่อน Connect DB เพื่อให้พร้อมเรียกใช้ restoreTimers
const vetoMgr = new VetoManager(io);
BracketManager.setIO(io);
BracketManager.onMatchReady = createMatchChannel; // [NEW] Hook up channel creation for next matches

// Share VetoManager
app.set('vetoMgr', vetoMgr);

// [FIX] Share IO, Discord Client, and Helper Functions with Routes
app.set('io', io);
app.set('discordClient', discordClient);
app.set('createMatchChannel', createMatchChannel);
app.set('deleteMatchChannels', deleteMatchChannels);
app.set('deleteMatchVoiceChannels', deleteMatchVoiceChannels);
app.set('sendMatchResultToDiscord', sendMatchResultToDiscord);

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

// --- [NEW] ROUTES IMPORT ---
// นำเข้า Router ที่แยกไฟล์ไว้
const teamRoutes = require('./routes/teamRoutes');
const matchRoutes = require('./routes/matchRoutes');
const tournamentRoutes = require('./routes/tournamentRoutes');
const discordRoutes = require('./routes/discordRoutes');
const adminRoutes = require('./routes/adminRoutes');
const overlayRoutes = require('./routes/overlayRoutes');

app.use('/api', teamRoutes);
app.use('/api', matchRoutes);
app.use('/api', tournamentRoutes);
app.use('/api', discordRoutes);
app.use('/api', adminRoutes);
app.use('/api', overlayRoutes);

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

// --- [MERGED] Helper Functions from discordBot.js ---

/**
 * ฟังก์ชัน: สร้างปุ่มสำหรับให้ผู้เล่นกดเลือกทีม
 * @param {string} channelId - ID ของช่อง Text ที่ต้องการส่งปุ่มไป
 * @param {Array} teams - ชื่อทีมทั้งหมด เช่น ['Team A', 'Team B']
 */
async function sendTeamRoleButtons(channelId, teams) {
    const channel = discordClient.channels.cache.get(channelId);
    if (!channel) return console.error('ไม่พบช่อง Discord ที่ระบุ');

    const row = new ActionRowBuilder();
    
    // สร้างปุ่มตามรายชื่อทีม
    teams.forEach(team => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`team_${team}`)
                .setLabel(`เข้าร่วม ${team}`)
                .setStyle(ButtonStyle.Primary),
        );
    });

    await channel.send({
        content: '👇 **กรุณากดปุ่มด้านล่างเพื่อรับยศประจำทีมของคุณ** 👇',
        components: [row]
    });
}

/**
 * ฟังก์ชัน: สร้างห้องแข่งขันแบบแยก Category (จาก discordBot.js เดิม)
 * @param {string} guildId - ID ของเซิร์ฟเวอร์ Discord
 * @param {Object} matchData - ข้อมูลแมตช์ (เลขแมตช์, ทีม A, ทีม B, ชื่อรายการ)
 */
async function createMatchChannels(guildId, matchData) {
    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) return console.error('ไม่พบเซิร์ฟเวอร์ Discord');

    const { matchNumber, teamA, teamB, tournamentName } = matchData;

    try {
        const category = await guild.channels.create({ name: `🏆 [${tournamentName}] Match ${matchNumber}`, type: ChannelType.GuildCategory });
        const textChannel = await guild.channels.create({ name: `💬-match-${matchNumber}-chat`, type: ChannelType.GuildText, parent: category.id });
        
        await textChannel.send(`🚨 **ประกาศเตือน!** 🚨\nแมตช์ระหว่าง **${teamA}** ⚔️ **${teamB}** กำลังจะเริ่มในอีก 15 นาที!`);
        await guild.channels.create({ name: `🎧 ทีม ${teamA}`, type: ChannelType.GuildVoice, parent: category.id });
        await guild.channels.create({ name: `🎧 ทีม ${teamB}`, type: ChannelType.GuildVoice, parent: category.id });

        console.log(`สร้างห้องการแข่งขัน Match ${matchNumber} สำเร็จ`);
        return category.id;
    } catch (error) { console.error('เกิดข้อผิดพลาดในการสร้างห้อง:', error); }
}

/**
 * ฟังก์ชัน: ลบห้องและ Category ของแมตช์ (Clean up)
 */
async function deleteMatchChannels(match) {
    if (!match.discordChannelId) return;

    try {
        // Fetch the text channel to find its parent category
        const channel = await discordClient.channels.fetch(match.discordChannelId).catch(() => null);
        if (!channel) return;

        const guild = channel.guild;
        const categoryId = channel.parentId;

        // 1. Delete the text channel
        await channel.delete().catch(e => console.log(`Failed to delete text channel: ${e.message}`));

        // 2. If inside a category, delete all siblings (Voice channels) and the Category
        if (categoryId) {
            const category = await guild.channels.fetch(categoryId).catch(() => null);
            if (category) {
                const children = guild.channels.cache.filter(c => c.parentId === categoryId);
                for (const [_, child] of children) {
                    await child.delete().catch(e => console.log(`Failed to delete child channel: ${e.message}`));
                }
                await category.delete().catch(e => console.log(`Failed to delete category: ${e.message}`));
                console.log(`🗑️ Deleted Discord channels for Match ${match.matchNumber}`);
            }
        }
    } catch (e) { console.error("Error deleting match channels:", e); }
}

/**
 * ฟังก์ชัน: ลบเฉพาะห้องเสียงของแมตช์ (Voice Channels Cleanup)
 */
async function deleteMatchVoiceChannels(match) {
    if (!match.discordChannelId) return;

    try {
        const channel = await discordClient.channels.fetch(match.discordChannelId).catch(() => null);
        if (!channel || !channel.parentId) return;

        const guild = channel.guild;
        const categoryId = channel.parentId;

        const children = guild.channels.cache.filter(c => c.parentId === categoryId && c.type === ChannelType.GuildVoice);
        for (const [_, child] of children) {
            await child.delete().catch(e => console.log(`Failed to delete voice channel: ${e.message}`));
        }
        console.log(`🗑️ Deleted Voice channels for Match ${match.matchNumber}`);

        // [NEW] Rename Category to [Finished]
        const category = await guild.channels.fetch(categoryId).catch(() => null);
        if (category) {
            const matchIdentifier = (match.matchNumber && match.matchNumber > 0) ? match.matchNumber : match._id.toString().slice(-4);
            await category.setName(`🏁 [Finished] Match ${matchIdentifier}`).catch(e => console.error(`Failed to rename category: ${e.message}`));
        }
    } catch (e) { console.error("Error deleting match voice channels:", e); }
}

/**
 * ฟังก์ชัน: ส่งผลการแข่งขันลง Discord (Scoreboard)
 */
async function sendMatchResultToDiscord(match) {
    try {
        // Calculate Series Score
        let scoreA = 0, scoreB = 0;
        if (match.scores) {
            match.scores.forEach(s => {
                const sA = parseInt(s.teamAScore) || 0;
                const sB = parseInt(s.teamBScore) || 0;
                if (sA > sB) scoreA++;
                else if (sB > sA) scoreB++;
            });
        }

        // Determine winner name safely
        let winnerName = 'Unknown';
        if (match.winner) {
            if (match.winner.name) winnerName = match.winner.name;
            else if (match.winner.toString() === match.teamA._id.toString()) winnerName = match.teamA.name;
            else if (match.winner.toString() === match.teamB._id.toString()) winnerName = match.teamB.name;
        }

        const embed = new EmbedBuilder()
            .setColor(0xff4655) // Valorant Red
            .setTitle(`🏆 MATCH RESULT: ${match.name}`)
            .setDescription(`**WINNER:** ${winnerName}\n**SERIES:** ${match.teamA.shortName} **${scoreA} - ${scoreB}** ${match.teamB.shortName}`)
            .setTimestamp();

        // Add Map Details
        if (match.scores && match.scores.length > 0) {
            let mapDetails = '';
            let lastProofImage = null;

            match.scores.forEach(s => {
                let proofUrl = s.proofImage;
                // Fix relative URL if CLIENT_URL is set (for local uploads)
                if (proofUrl && !proofUrl.startsWith('http') && process.env.CLIENT_URL) {
                     proofUrl = new URL(proofUrl, process.env.CLIENT_URL).toString();
                }

                const proofLink = (proofUrl && proofUrl.startsWith('http')) ? ` | 📸 Proof` : '';
                if (proofUrl && proofUrl.startsWith('http')) lastProofImage = proofUrl;

                mapDetails += `**${s.mapName}**: ${match.teamA.shortName} **${s.teamAScore} - ${s.teamBScore}** ${match.teamB.shortName}${proofLink}\n`;
            });
            embed.addFields({ name: 'Map Scores', value: mapDetails });

            // Show the last proof image in the embed
            if (lastProofImage) {
                embed.setImage(lastProofImage);
            }
        }

        // 1. Send to Match Channel
        if (match.discordChannelId) {
            const channel = await discordClient.channels.fetch(match.discordChannelId).catch(() => null);
            if (channel) await channel.send({ embeds: [embed] });
        }

        // 2. Send to Global Results Channel
        const resultsChannelId = process.env.DISCORD_RESULTS_CHANNEL_ID;
        if (resultsChannelId) {
            const resultsChannel = await discordClient.channels.fetch(resultsChannelId).catch(() => null);
            if (resultsChannel) await resultsChannel.send({ embeds: [embed] });
        }

        console.log(`Sent match result to Discord for Match ${match.matchNumber}`);

    } catch (e) {
        console.error("Error sending match result to Discord:", e);
    }
}

// --- [UPDATED] Auto-Setup All Discord Channels ---
async function setupDiscordChannels() {
    if (!DISCORD_GUILD_ID) return console.log("⚠️ DISCORD_GUILD_ID not set, skipping auto-setup.");

    try {
        const guild = await discordClient.guilds.fetch(DISCORD_GUILD_ID).catch(() => null);
        if (!guild) return console.log("⚠️ Bot not in guild, skipping auto-setup.");

        // Helper to ensure channel exists
        const ensureChannel = async (name, type, envVarName, permissionOverwrites = []) => {
            let channelId = process.env[envVarName];
            let channel;

            if (channelId) channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel) channel = guild.channels.cache.find(c => c.name === name && c.type === type);

            if (!channel) {
                channel = await guild.channels.create({
                    name: name,
                    type: type,
                    permissionOverwrites: permissionOverwrites
                });
                console.log(`✅ Created #${name} channel: ${channel.id}`);
            } else {
                console.log(`✅ Found #${name} channel: ${channel.id}`);
            }
            process.env[envVarName] = channel.id;
            return channel;
        };

        // 1. Verify Role Channel (Public Read-Only)
        const verifyChannel = await ensureChannel('verify-role', ChannelType.GuildText, 'DISCORD_CLAIM_CHANNEL_ID', [
            { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }
        ]);

        // 2. Admin Logs Channel (Private)
        await ensureChannel('admin-logs', ChannelType.GuildText, 'DISCORD_ADMIN_LOG_CHANNEL_ID', [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] } 
        ]);

        // 3. Match Results Channel (Public Read-Only)
        await ensureChannel('match-results', ChannelType.GuildText, 'DISCORD_RESULTS_CHANNEL_ID', [
            { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }
        ]);

        // Send Button to Verify Channel if needed
        const messages = await verifyChannel.messages.fetch({ limit: 10 }).catch(() => []);
        const hasButton = messages.some && messages.some(m => m.author.id === discordClient.user.id && m.components.length > 0);

        if (!hasButton) {
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

            await verifyChannel.send({ embeds: [embed], components: [row] });
            console.log("✅ Sent Claim Button to #verify-role");
        }
    } catch (e) {
        console.error("❌ Auto-setup Channels Error:", e);
    }
}
