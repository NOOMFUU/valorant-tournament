const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const Match = require('../models/Match');
const Team = require('../models/Team');
const BracketManager = require('../managers/bracketManager');
const discordService = require('./discordService');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let vetoMgr = null;

async function init(vetoManagerInstance) {
    vetoMgr = vetoManagerInstance;
    discordService.init(client);
    
    if (process.env.DISCORD_TOKEN) {
        await client.login(process.env.DISCORD_TOKEN);
    }
}

client.once('clientReady', async () => {
    console.log(`🤖 Discord Bot Logged in as ${client.user.tag}`);
    client.user.setActivity('Valorant Comp', { type: 'COMPETING' });
    await discordService.setupDiscordChannels();

    const commands = [
        {
            name: 'match-info',
            description: 'Get details about a specific match',
            options: [{ name: 'match_id', type: 3, description: 'The Match ID', required: true }]
        },
        {
            name: 'reset-veto',
            description: 'Reset the veto process for a match (Admin only)',
            options: [{ name: 'match_id', type: 3, description: 'The Match ID', required: true }]
        },
        {
            name: 'force-win',
            description: 'Force a win for a team (Admin only)',
            options: [
                { name: 'match_id', type: 3, description: 'The Match ID', required: true },
                { name: 'team_name', type: 3, description: 'Winning Team Name (partial match)', required: true }
            ]
        }
    ];

    try {
        await client.application.commands.set(commands, process.env.DISCORD_GUILD_ID);
        console.log('✅ Slash Commands Registered');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
});

client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        return handleSlashCommand(interaction);
    }

    if (!interaction.isButton()) return;

    if (interaction.customId.startsWith('team_')) {
        const teamName = interaction.customId.replace('team_', '');
        await interaction.reply({ 
            content: `คุณได้ยืนยันตัวตนเข้าสู่ทีม **${teamName}** แล้ว! (ระบบกำลังจ่ายยศให้คุณ)`, 
            ephemeral: true 
        });
        return;
    }

    if (interaction.customId.startsWith('checkin_')) {
        const matchId = interaction.customId.replace('checkin_', '');
        const match = await Match.findById(matchId).populate('teamA teamB');
        
        if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

        const discordId = interaction.user.id;
        let teamSide = null;

        if (match.teamA.members.some(m => m.discordId === discordId)) teamSide = 'teamA';
        else if (match.teamB.members.some(m => m.discordId === discordId)) teamSide = 'teamB';

        if (!teamSide) {
            return interaction.reply({ content: '❌ You are not a player in this match.', ephemeral: true });
        }

        if (match.checkIn[teamSide]) {
            return interaction.reply({ content: '✅ Your team is already checked in.', ephemeral: true });
        }

        match.checkIn[teamSide] = true;
        await match.save();

        await interaction.reply({ content: `✅ **${match[teamSide].name}** Checked In!`, ephemeral: false });
        return;
    }

    if (interaction.customId === 'claim_role') {
        await interaction.deferReply({ ephemeral: true });

        try {
            const discordId = interaction.user.id;
            const discordUsername = interaction.user.username;

            let team = await Team.findOne({ "members.discordId": discordId });
            let member;

            if (team) {
                member = team.members.find(m => m.discordId === discordId);
            } else {
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
                        member = found;
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
            let role;
            if (team.discordRoleId) role = await guild.roles.fetch(team.discordRoleId).catch(() => null);

            if (!role) {
                role = guild.roles.cache.find(r => r.name === team.name);
                if (role) {
                    team.discordRoleId = role.id;
                    await team.save();
                }
            }

            if (!role) {
                role = await guild.roles.create({ name: team.name, color: '#ff4655', reason: 'Tournament Team Role' });
                team.discordRoleId = role.id;
                await team.save();
            }

            const guildMember = await guild.members.fetch(discordId);
            await guildMember.roles.add(role);

            const nickname = `${team.shortName} | ${member.name}`;
            await guildMember.setNickname(nickname).catch(e => console.log(`⚠️ Cannot set nickname for ${discordUsername}: ${e.message}`));

            interaction.editReply({ content: `✅ ยืนยันตัวตนสำเร็จ! คุณได้รับยศ **${team.name}** เรียบร้อยแล้ว` });

        } catch (error) {
            console.error("Discord Claim Error:", error);
            interaction.editReply({ content: "⚠️ An error occurred while processing your request." });
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    if (message.content === '!deletecategory') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const categoryId = message.channel.parentId;
        if (!categoryId) return message.reply("❌ This channel is not inside a category.");

        const category = message.guild.channels.cache.get(categoryId);
        if (!category) return message.reply("❌ Category not found.");

        await message.reply(`⚠️ **WARNING:** Deleting category **${category.name}** and all channels inside it in 5 seconds...`);

        setTimeout(async () => {
            const channels = message.guild.channels.cache.filter(c => c.parentId === categoryId);
            for (const [_, ch] of channels) {
                await ch.delete().catch(e => console.error(`Failed to delete channel ${ch.name}:`, e.message));
            }
            await category.delete().catch(e => console.error(`Failed to delete category ${category.name}:`, e.message));
        }, 5000);
    }
});

client.on('guildMemberAdd', async member => {
    try {
        const discordId = member.id;
        const discordUsername = member.user.username;
        let team = await Team.findOne({ "members.discordId": discordId });
        let teamMember;

        if (team) {
            teamMember = team.members.find(m => m.discordId === discordId);
        } else {
            const potentialTeams = await Team.find({ "members.discordName": { $regex: new RegExp(discordUsername, "i") } });
            for (const t of potentialTeams) {
                const found = t.members.find(m => {
                    if (!m.discordName) return false;
                    const dbName = m.discordName.toLowerCase().trim();
                    const inputName = discordUsername.toLowerCase();
                    return dbName === inputName || dbName.split('#')[0] === inputName;
                });
                if (found) {
                    team = t; teamMember = found;
                    if (!teamMember.discordId) { teamMember.discordId = discordId; await team.save(); }
                    break;
                }
            }
        }

        if (team && teamMember) {
            const guild = member.guild;
            let role = team.discordRoleId ? await guild.roles.fetch(team.discordRoleId).catch(() => null) : null;
            if (!role) {
                role = await guild.roles.create({ name: team.name, color: '#ff4655', reason: 'Auto-Assign' });
                team.discordRoleId = role.id; await team.save();
            }
            await member.roles.add(role);
            await member.setNickname(`${team.shortName} | ${teamMember.name}`).catch(() => {});
        }
    } catch (error) { console.error("Auto-Assign Role Error:", error); }
});

async function handleSlashCommand(interaction) {
    const { commandName, options } = interaction;
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (commandName === 'match-info') {
        const matchId = options.getString('match_id');
        try {
            const match = await Match.findById(matchId).populate('teamA teamB');
            if (!match) return interaction.reply({ content: 'Match not found', ephemeral: true });
            const embed = new EmbedBuilder().setTitle(`Match: ${match.name}`).addFields({ name: 'Status', value: match.status, inline: true }, { name: 'Team A', value: match.teamA.name, inline: true }, { name: 'Team B', value: match.teamB.name, inline: true }).setColor('#ff4655');
            interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (e) { interaction.reply({ content: 'Error', ephemeral: true }); }
    }
    if (commandName === 'reset-veto') {
        if (!isAdmin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const match = await Match.findById(options.getString('match_id'));
        if (!match) return interaction.reply({ content: 'Match not found', ephemeral: true });
        if (vetoMgr) await vetoMgr.resetVeto(match);
        interaction.reply({ content: `✅ Veto reset`, ephemeral: true });
    }
    if (commandName === 'force-win') {
        if (!isAdmin) return interaction.reply({ content: '❌ Admin only', ephemeral: true });
        const match = await Match.findById(options.getString('match_id')).populate('teamA teamB');
        // ... force win logic ...
        interaction.reply({ content: `✅ Forced win`, ephemeral: true });
    }
}

module.exports = { init, client };