require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Events, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const mongoose = require('mongoose');
const Team = require('./models/Team'); // เรียกใช้ Model Team ที่เราแก้ไขไป
const Match = require('./models/Match');

// --- Configuration ---
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID; // Application ID จาก Discord Developer Portal
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/valorant-tourney';

// --- Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // ต้องเปิด "Server Members Intent" ใน Discord Developer Portal
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.GuildMember]
});

// --- MongoDB Connection ---
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected (Bot)'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// --- Slash Command Registration ---
const commands = [
    new SlashCommandBuilder()
        .setName('setup-verification')
        .setDescription('สร้างปุ่มสำหรับกดรับยศทีม (Admin Only)')
        .setDefaultMemberPermissions(0x8), // Administrator permission
    new SlashCommandBuilder()
        .setName('link-user')
        .setDescription('เชื่อมต่อบัญชีเว็บกับ Discord (Admin Only)')
        .setDefaultMemberPermissions(0x8)
        .addStringOption(option => 
            option.setName('username').setDescription('Username ในเว็บไซต์').setRequired(true))
        .addUserOption(option => 
            option.setName('discord_user').setDescription('Discord User ที่ต้องการเชื่อมต่อ').setRequired(true)),
    new SlashCommandBuilder()
        .setName('create-match-channels')
        .setDescription('สร้างห้องเสียงสำหรับแมตช์ที่กำลังจะแข่ง (Admin Only)')
        .setDefaultMemberPermissions(0x8),
    new SlashCommandBuilder()
        .setName('archive-channels')
        .setDescription('ลบห้องแข่งขันที่จบแล้วทั้งหมด (Admin Only)')
        .setDefaultMemberPermissions(0x8)
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
    try {
        console.log('🔄 Started refreshing application (/) commands.');
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands },
        );
        console.log('✅ Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

// --- Event Handlers ---

client.on(Events.ClientReady, () => {
    console.log(`🤖 Logged in as ${client.user.tag}!`);
});

client.on(Events.InteractionCreate, async interaction => {
    // 1. Handle Slash Command (/setup-verification)
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'setup-verification') {
            const embed = new EmbedBuilder()
                .setTitle('🛡️ Team Role Verification')
                .setDescription('กดปุ่มด้านล่างเพื่อยืนยันตัวตนและรับยศทีมของคุณ\nClick the button below to verify and claim your team role.')
                .setColor(0x0099FF)
                .setFooter({ text: 'Valorant Tournament System' });

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('claim_team_role')
                        .setLabel('รับยศทีม / Claim Role')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('🎮')
                );

            await interaction.reply({ embeds: [embed], components: [row] });
        }

        if (interaction.commandName === 'link-user') {
            await interaction.deferReply({ ephemeral: true });
            const username = interaction.options.getString('username');
            const targetUser = interaction.options.getUser('discord_user');

            try {
                if (!process.env.API_URL || !process.env.BOT_API_SECRET) {
                    return await interaction.editReply('❌ API Configuration missing (.env)');
                }

                const response = await fetch(`${process.env.API_URL}/api/discord/link-user`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.BOT_API_SECRET}`
                    },
                    body: JSON.stringify({
                        username: username,
                        discordId: targetUser.id
                    })
                });

                const data = await response.json();
                if (response.ok && data.success) {
                    await interaction.editReply(`✅ **เชื่อมต่อสำเร็จ!**\nWeb User: \`${username}\`\nDiscord: ${targetUser.toString()}`);
                } else {
                    await interaction.editReply(`❌ **เชื่อมต่อไม่สำเร็จ**: ${data.error || data.message || 'Unknown error'}`);
                }
            } catch (error) {
                console.error('Link User Error:', error);
                await interaction.editReply('❌ เกิดข้อผิดพลาดในการเชื่อมต่อ API');
            }
        }

        if (interaction.commandName === 'create-match-channels') {
            await interaction.deferReply({ ephemeral: true });
            try {
                // ค้นหาแมตช์ที่ยังไม่ได้แข่ง หรือกำลังแข่ง และยังไม่มีห้อง
                const matches = await Match.find({
                    status: { $in: ['scheduled', 'live'] },
                    discordChannelId: { $exists: false }
                }).populate('teamA teamB');

                if (matches.length === 0) {
                    return await interaction.editReply('✅ ไม่พบแมตช์ที่ต้องสร้างห้องใหม่');
                }

                const guild = interaction.guild;
                // หาหรือสร้าง Category
                let category = guild.channels.cache.find(c => c.name === 'TOURNAMENT MATCHES' && c.type === ChannelType.GuildCategory);
                if (!category) {
                    category = await guild.channels.create({
                        name: 'TOURNAMENT MATCHES',
                        type: ChannelType.GuildCategory,
                    });
                }

                let count = 0;
                for (const m of matches) {
                    if (!m.teamA || !m.teamB) continue;
                    // ข้ามถ้าทีมยังไม่มี Role ID (เพราะจะตั้ง Permission ไม่ได้)
                    if (!m.teamA.discordRoleId || !m.teamB.discordRoleId) continue;

                    const chName = `m${String(m.matchNumber).padStart(3,'0')} ${m.teamA.shortName} vs ${m.teamB.shortName}`;
                    
                    const channel = await guild.channels.create({
                        name: chName,
                        type: ChannelType.GuildVoice,
                        parent: category.id,
                        permissionOverwrites: [
                            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // คนทั่วไปมองไม่เห็น
                            { id: m.teamA.discordRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
                            { id: m.teamB.discordRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }
                        ]
                    });
                    
                    m.discordChannelId = channel.id;
                    await m.save();

                    // [NEW] Send Welcome Message
                    if (channel) {
                        const roleA = m.teamA.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : m.teamA.shortName;
                        const roleB = m.teamB.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : m.teamB.shortName;
                        await channel.send(`📢 **MATCH READY**\n${roleA} vs ${roleB}\n\nห้องแข่งขันถูกสร้างแล้ว กรุณามารายงานตัวและเตรียมพร้อมสำหรับการแข่งขัน!\nMatch channel created. Please report and get ready!`);
                    }

                    count++;
                }
                await interaction.editReply(`✅ สร้างห้องสำเร็จ ${count} ห้อง`);
            } catch (e) { console.error(e); await interaction.editReply('❌ Error: ' + e.message); }
        }

        if (interaction.commandName === 'archive-channels') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const matches = await Match.find({
                    status: 'finished',
                    discordChannelId: { $exists: true, $ne: '' }
                });

                if (matches.length === 0) {
                    return await interaction.editReply('✅ ไม่พบห้องที่ต้องลบ (ไม่มีแมตช์ที่จบแล้วค้างอยู่)');
                }

                let count = 0;
                for (const m of matches) {
                    try {
                        const channel = await client.channels.fetch(m.discordChannelId).catch(() => null);
                        if (channel) await channel.delete();
                        
                        m.discordChannelId = ''; // ลบ ID ออกจาก Database เพื่อไม่ให้บอทพยายามหาอีก
                        await m.save();
                        count++;
                    } catch (err) { console.error(`Failed to archive channel for match ${m._id}:`, err.message); }
                }
                await interaction.editReply(`🗑️ ลบห้องสำเร็จ ${count} ห้อง`);
            } catch (e) { console.error(e); await interaction.editReply('❌ Error: ' + e.message); }
        }
    }

    // 2. Handle Button Click (claim_team_role)
    if (interaction.isButton()) {
        if (interaction.customId === 'claim_team_role') {
            // Defer reply เพื่อบอกว่าบอทกำลังคิด (ป้องกัน Timeout)
            await interaction.deferReply({ ephemeral: true });

            try {
                const userId = interaction.user.id;
                const username = interaction.user.username; // ชื่อผู้ใช้ (เช่น sarayut)
                const userTag = interaction.user.tag;       // ชื่อแบบเก่า (เช่น User#1234)
                
                // ค้นหาทีมที่มีสมาชิกคนนี้อยู่ (เช็คจาก ID หรือ Username หรือ Tag)
                // ใช้ Regex เพื่อให้ค้นหาแบบไม่สนตัวพิมพ์เล็ก-ใหญ่ (Case Insensitive) สำหรับ Username
                const team = await Team.findOne({ 
                    status: 'approved',
                    $or: [
                        { "members.discordId": userId },
                        { "members.discordId": username }, 
                        { "members.discordId": userTag },
                        // กรณีพิมพ์ชื่อมาแบบตัวใหญ่/เล็กไม่ตรงกัน (Case Insensitive)
                        { "members.discordId": { $regex: new RegExp(`^${username}$`, 'i') } }
                    ]
                });

                if (!team) {
                    return await interaction.editReply({ 
                        content: '❌ **ไม่พบข้อมูลของคุณในทีมใดๆ**\nกรุณาตรวจสอบว่าหัวหน้าทีมได้กรอก **Discord Username** ของคุณในหน้า Roster ถูกต้องหรือไม่ (ไม่ต้องใส่ @)' 
                    });
                }

                if (!team.discordRoleId) {
                    return await interaction.editReply({ 
                        content: `⚠️ พบทีมของคุณ: **${team.name}** แต่ทีมนี้ยังไม่ได้ตั้งค่า Role ID ในระบบ` 
                    });
                }

                // หา Role ใน Discord Server
                const role = interaction.guild.roles.cache.get(team.discordRoleId);
                if (!role) {
                    return await interaction.editReply({ 
                        content: `❌ ไม่พบ Role บน Discord (ID: ${team.discordRoleId}) กรุณาติดต่อ Admin` 
                    });
                }

                // หา Member คนนั้นใน Array เพื่ออัปเดตข้อมูล
                const member = team.members.find(m => 
                    m.discordId === userId || 
                    m.discordId === username || 
                    m.discordId === userTag ||
                    m.discordId.toLowerCase() === username.toLowerCase()
                );

                // ถ้าเจอผ่าน Username ให้บันทึกเป็น ID จริงๆ กลับไป (ครั้งหน้าจะได้หาเจอง่ายๆ และเปลี่ยนชื่อได้)
                if (member && member.discordId !== userId) {
                    member.discordId = userId;
                    await team.save();
                    console.log(`🔄 Updated Discord ID for ${username} from "${member.discordId}" to "${userId}"`);
                }

                // เพิ่ม Role ให้สมาชิก
                const guildMember = interaction.member;
                if (guildMember.roles.cache.has(role.id)) {
                    return await interaction.editReply({ 
                        content: `✅ คุณมียศ **${role.name}** อยู่แล้ว!` 
                    });
                }

                await guildMember.roles.add(role);
                
                // [NEW] Call API to sync status with Website
                try {
                    // ตรวจสอบว่ามีการตั้งค่า API URL และ Secret หรือไม่
                    if (process.env.API_URL && process.env.BOT_API_SECRET) {
                        await fetch(`${process.env.API_URL}/api/discord/verify-member`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${process.env.BOT_API_SECRET}`
                            },
                            body: JSON.stringify({
                                discordId: userId,
                                discordTag: interaction.user.tag
                            })
                        });
                    }
                } catch (err) {
                    console.error('❌ API Sync Error:', err.message);
                }

                await interaction.editReply({ 
                    content: `✅ **ยืนยันตัวตนสำเร็จ!**\nคุณได้รับยศ **${role.name}** เรียบร้อยแล้ว` 
                });

            } catch (error) {
                console.error('Error giving role:', error);
                await interaction.editReply({ content: '❌ เกิดข้อผิดพลาดในการดำเนินการ กรุณาลองใหม่ภายหลัง' });
            }
        }
    }
});

// [NEW] Polling for Notifications (Check every 1 minute)
setInterval(async () => {
    try {
        const now = new Date();
        const tenMinutesLater = new Date(now.getTime() + 10 * 60000);
        
        // 1. 10 Minute Warning
        const upcomingMatches = await Match.find({
            status: 'scheduled',
            discordChannelId: { $exists: true, $ne: '' },
            "notifications.tenMinutes": { $ne: true },
            scheduledTime: { $lte: tenMinutesLater, $gt: now }
        }).populate('teamA teamB');

        for (const m of upcomingMatches) {
            try {
                const channel = await client.channels.fetch(m.discordChannelId);
                if (channel) {
                    const roleA = m.teamA?.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : m.teamA?.shortName;
                    const roleB = m.teamB?.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : m.teamB?.shortName;
                    await channel.send(`⏰ **10 MINUTES REMAINING**\n${roleA} ${roleB}\nการแข่งขันจะเริ่มในอีก 10 นาที กรุณาเตรียมตัวให้พร้อม!\nThe match will start in 10 minutes.`);
                    
                    m.notifications.tenMinutes = true;
                    await m.save();
                }
            } catch (err) {
                console.error(`Failed to send 10m warning for match ${m._id}:`, err.message);
            }
        }

        // 2. Reschedule Notification
        const rescheduleMatches = await Match.find({
            "rescheduleRequest.status": 'pending',
            discordChannelId: { $exists: true, $ne: '' },
            "notifications.reschedule": { $ne: true }
        }).populate('teamA teamB');

        for (const m of rescheduleMatches) {
            try {
                const channel = await client.channels.fetch(m.discordChannelId);
                if (channel) {
                    const requesterId = m.rescheduleRequest.requestedBy.toString();
                    const requesterName = (m.teamA._id.toString() === requesterId) ? m.teamA.name : m.teamB.name;
                    const proposedTime = new Date(m.rescheduleRequest.proposedTime).toLocaleString('th-TH');
                    
                    const roleA = m.teamA?.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : m.teamA?.shortName;
                    const roleB = m.teamB?.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : m.teamB?.shortName;

                    await channel.send(`📅 **RESCHEDULE REQUEST**\n${roleA} ${roleB}\n\nทีม **${requesterName}** ได้ขอเลื่อนเวลาการแข่งขันเป็น: **${proposedTime}**\nกรุณาเข้าไปตอบรับหรือปฏิเสธในเว็บไซต์\n\nTeam **${requesterName}** requested a reschedule to: **${proposedTime}**\nPlease accept or reject on the website.`);
                    
                    m.notifications.reschedule = true;
                    await m.save();
                }
            } catch (err) {
                console.error(`Failed to send reschedule notif for match ${m._id}:`, err.message);
            }
        }

        // 4. Forfeit Claim Notification
        const forfeitMatches = await Match.find({
            status: 'pending_approval',
            "scoreSubmission.rejectReason": 'FORFEIT CLAIM',
            discordChannelId: { $exists: true, $ne: '' },
            "notifications.forfeitClaim": { $ne: true }
        }).populate('teamA teamB');

        for (const m of forfeitMatches) {
            try {
                const channel = await client.channels.fetch(m.discordChannelId);
                if (channel) {
                    const claimerId = m.scoreSubmission.submittedBy.toString();
                    const claimerName = (m.teamA._id.toString() === claimerId) ? m.teamA.name : m.teamB.name;
                    
                    const roleA = m.teamA?.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : m.teamA?.shortName;
                    const roleB = m.teamB?.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : m.teamB?.shortName;

                    await channel.send(`🚨 **FORFEIT CLAIMED**\n${roleA} ${roleB}\n\nทีม **${claimerName}** ได้ส่งคำร้องขอชนะบาย (Forfeit Claim) พร้อมหลักฐาน\nกรุณารอ Admin ตรวจสอบ\n\nTeam **${claimerName}** has claimed a forfeit win with proof.\nAwaiting Admin verification.`);
                    
                    m.notifications.forfeitClaim = true;
                    await m.save();
                }
            } catch (err) {
                console.error(`Failed to send forfeit notif for match ${m._id}:`, err.message);
            }
        }

        // 5. Score Approved Notification
        const approvedMatches = await Match.find({
            status: 'finished',
            discordChannelId: { $exists: true, $ne: '' },
            "notifications.scoreApproved": { $ne: true }
        }).populate('teamA teamB winner');

        for (const m of approvedMatches) {
            try {
                const channel = await client.channels.fetch(m.discordChannelId).catch(() => null);
                if (channel) {
                    const winnerName = m.winner ? m.winner.name : 'Unknown';
                    let scoreDisplay = '';
                    if (m.scores && m.scores.length > 0) {
                        scoreDisplay = m.scores.map(s => `• **${s.mapName}**: ${s.teamAScore} - ${s.teamBScore}`).join('\n');
                    }

                    const roleA = m.teamA?.discordRoleId ? `<@&${m.teamA.discordRoleId}>` : (m.teamA?.shortName || 'Team A');
                    const roleB = m.teamB?.discordRoleId ? `<@&${m.teamB.discordRoleId}>` : (m.teamB?.shortName || 'Team B');

                    await channel.send(`🏆 **MATCH RESULT CONFIRMED**\n${roleA} vs ${roleB}\n\nAdmin has approved the match results.\n**Winner:** ${winnerName}\n\n${scoreDisplay}\n\nThank you for participating!`);
                    
                    m.notifications.scoreApproved = true;
                    await m.save();
                }
            } catch (err) { console.error(`Failed to send approved notif for match ${m._id}:`, err.message); }
        }

        // 3. Update Channel Name based on Status
        const activeMatches = await Match.find({
            discordChannelId: { $exists: true, $ne: '' }
        }).populate('teamA teamB');

        for (const m of activeMatches) {
            try {
                const channel = await client.channels.fetch(m.discordChannelId).catch(() => null);
                if (!channel) continue;

                let prefix = '';
                if (m.status === 'live') prefix = '[LIVE] ';
                else if (m.status === 'finished') prefix = '[END] ';

                const teamA = m.teamA ? m.teamA.shortName : 'TBD';
                const teamB = m.teamB ? m.teamB.shortName : 'TBD';
                const baseName = `m${String(m.matchNumber).padStart(3,'0')} ${teamA} vs ${teamB}`;
                const newName = `${prefix}${baseName}`;

                if (channel.name !== newName) {
                    await channel.setName(newName);
                }
            } catch (err) {
                console.error(`Failed to update channel name for match ${m._id}:`, err.message);
            }
        }

    } catch (error) {
        console.error('Notification Loop Error:', error);
    }
}, 60 * 1000);

client.login(TOKEN);