const { EmbedBuilder, ChannelType, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const Team = require('../models/Team');

class DiscordService {
    constructor() {
        this.client = null;
        this.guildId = process.env.DISCORD_GUILD_ID;
        this.spectatorRoleId = process.env.DISCORD_SPECTATOR_ROLE_ID;
        this.channelCreationQueue = [];
        this.isProcessingChannels = false;
    }

    init(client) {
        this.client = client;
    }

    async withRetry(fn, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                // Don't retry if it's a 404-like error (Unknown Channel/Role) or Missing Permissions
                if (i === retries - 1 || [10003, 10011, 50001].includes(error.code)) throw error;
                
                console.warn(`⚠️ Discord API Retry (${i + 1}/${retries}): ${error.message}`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
            }
        }
    }

    async logToAdminChannel(message) {
        const channelId = process.env.DISCORD_ADMIN_LOGS_CHANNEL_ID;
        if (!channelId || !this.client) return;
        try {
            const channel = await this.client.channels.fetch(channelId);
            if (channel) channel.send(`📝 **ADMIN LOG:** ${message}`);
        } catch (e) { console.error('Failed to send admin log:', e); }
    }

    // Wrapper for Queue
    createMatchChannel(match) {
        this.channelCreationQueue.push({ match });
        this.processChannelQueue();
    }

    async processChannelQueue() {
        if (this.isProcessingChannels || this.channelCreationQueue.length === 0) return;
        this.isProcessingChannels = true;

        const { match } = this.channelCreationQueue.shift();
        try {
            await this.createMatchChannelInternal(match);
        } catch (e) { console.error(`Queue Error for match ${match._id}:`, e); }
        
        setTimeout(() => { this.isProcessingChannels = false; this.processChannelQueue(); }, 1000); // 1 sec delay
    }

    async createMatchChannelInternal(match) {
        if (!this.client || !match.teamA || !match.teamB) return;
        if (match.discordChannelId) return;

        try {
            const guild = await this.withRetry(() => this.client.guilds.fetch(this.guildId));
            if (!guild) return;

            const teamA = await Team.findById(match.teamA);
            const teamB = await Team.findById(match.teamB);

            const ensureTeamRole = async (team) => {
                let role;
                if (team.discordRoleId) role = await this.withRetry(() => guild.roles.fetch(team.discordRoleId)).catch(() => null);
                if (!role) {
                    role = guild.roles.cache.find(r => r.name === team.name);
                    if (!role) {
                        try {
                            role = await this.withRetry(() => guild.roles.create({ name: team.name, color: '#ff4655', reason: 'Auto-created for Match' }));
                        } catch (e) { console.error(`Failed to create role for ${team.name}:`, e.message); }
                    }
                    if (role) {
                        team.discordRoleId = role.id;
                        await team.save();
                    }
                }
                return role;
            };

            await ensureTeamRole(teamA);
            await ensureTeamRole(teamB);

            if (!teamA.discordRoleId || !teamB.discordRoleId) return;

            const matchIdentifier = (match.matchNumber && match.matchNumber > 0) ? match.matchNumber : match._id.toString().slice(-4);
            const categoryName = `🏆 Match ${matchIdentifier}: ${teamA.shortName} vs ${teamB.shortName}`;
            
            const overwrites = [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: teamA.discordRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect] },
                { id: teamB.discordRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.Connect] },
            ];

            if (this.spectatorRoleId) {
                overwrites.push({
                    id: this.spectatorRoleId,
                    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect]
                });
            }

            const category = await this.withRetry(() => guild.channels.create({
                name: categoryName,
                type: ChannelType.GuildCategory,
                permissionOverwrites: overwrites,
                reason: `Match Creation: ${match.name}`
            }));

            const textChannel = await this.withRetry(() => guild.channels.create({
                name: `💬-match-${matchIdentifier}-chat`,
                type: ChannelType.GuildText,
                parent: category.id,
                reason: `Match Text Channel`
            }));

            const createVoice = async (team, opponentRole) => {
                await this.withRetry(() => guild.channels.create({
                    name: `🔊 ${team.shortName} (M${matchIdentifier})`,
                    type: ChannelType.GuildVoice,
                    parent: category.id,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: team.discordRoleId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] },
                        { id: opponentRole, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.Connect] }
                    ],
                }));
            };

            await createVoice(teamA, teamB.discordRoleId);
            await createVoice(teamB, teamA.discordRoleId);

            match.discordChannelId = textChannel.id;
            await match.save();

            const timeStr = match.scheduledTime ? `<t:${Math.floor(new Date(match.scheduledTime).getTime() / 1000)}:F>` : 'TBD';
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`checkin_${match._id}`).setLabel('✅ Check-in').setStyle(ButtonStyle.Success)
            );

            await this.withRetry(() => textChannel.send({
                content: `**MATCH READY**\n<@&${teamA.discordRoleId}> vs <@&${teamB.discordRoleId}>\nScheduled for: ${timeStr}\n\n**Please Check-in when ready:**`,
                components: [row]
            }));

        } catch (e) {
            console.error("Error creating match channel:", e);
        }
    }

    async updateMatchTime(match) {
        if (!this.client || !match.discordChannelId) return;
        try {
            const channel = await this.withRetry(() => this.client.channels.fetch(match.discordChannelId)).catch(() => null);
            if (!channel) return;

            const timeStr = match.scheduledTime ? `<t:${Math.floor(new Date(match.scheduledTime).getTime() / 1000)}:F>` : 'TBD';
            
            const messages = await this.withRetry(() => channel.messages.fetch({ limit: 50 })).catch(() => null);
            if (messages) {
                const targetMsg = messages.find(m => m.author.id === this.client.user.id && m.content.includes('Scheduled for:'));
                if (targetMsg) {
                    const newContent = targetMsg.content.replace(/Scheduled for: .*/, `Scheduled for: ${timeStr}`);
                    await this.withRetry(() => targetMsg.edit(newContent));
                } else {
                    await this.withRetry(() => channel.send(`📅 **MATCH UPDATE**\nNew Schedule: ${timeStr}`));
                }
            }
        } catch (e) { console.error("Error updating match time:", e); }
    }

    async deleteMatchChannels(match) {
        if (!this.client || !match.discordChannelId) return;
        try {
            const channel = await this.withRetry(() => this.client.channels.fetch(match.discordChannelId)).catch(() => null);
            if (!channel) return;

            const guild = channel.guild;
            const categoryId = channel.parentId;

            await this.withRetry(() => channel.delete()).catch(e => console.log(`Failed to delete text channel: ${e.message}`));

            if (categoryId) {
                const category = await this.withRetry(() => guild.channels.fetch(categoryId)).catch(() => null);
                if (category) {
                    const children = guild.channels.cache.filter(c => c.parentId === categoryId);
                    for (const [_, child] of children) {
                        await this.withRetry(() => child.delete()).catch(e => console.log(`Failed to delete child channel: ${e.message}`));
                    }
                    await this.withRetry(() => category.delete()).catch(e => console.log(`Failed to delete category: ${e.message}`));
                }
            }
        } catch (e) { console.error("Error deleting match channels:", e); }
    }

    async deleteMatchVoiceChannels(match) {
        if (!this.client || !match.discordChannelId) return;
        try {
            const channel = await this.withRetry(() => this.client.channels.fetch(match.discordChannelId)).catch(() => null);
            if (!channel || !channel.parentId) return;

            const guild = channel.guild;
            const categoryId = channel.parentId;
            const children = guild.channels.cache.filter(c => c.parentId === categoryId && c.type === ChannelType.GuildVoice);
            
            for (const [_, child] of children) {
                await this.withRetry(() => child.delete()).catch(e => console.log(`Failed to delete voice channel: ${e.message}`));
            }

            const category = await this.withRetry(() => guild.channels.fetch(categoryId)).catch(() => null);
            if (category) {
                const matchIdentifier = (match.matchNumber && match.matchNumber > 0) ? match.matchNumber : match._id.toString().slice(-4);
                await this.withRetry(() => category.setName(`🏁 [Finished] Match ${matchIdentifier}`)).catch(e => console.error(`Failed to rename category: ${e.message}`));
            }
        } catch (e) { console.error("Error deleting match voice channels:", e); }
    }

    async sendMatchResultToDiscord(match) {
        if (!this.client) return;
        try {
            let scoreA = 0, scoreB = 0;
            if (match.scores) {
                match.scores.forEach(s => {
                    const sA = parseInt(s.teamAScore) || 0;
                    const sB = parseInt(s.teamBScore) || 0;
                    if (sA > sB) scoreA++; else if (sB > sA) scoreB++;
                });
            }

            let winnerName = 'Unknown';
            if (match.winner) {
                if (match.winner.name) winnerName = match.winner.name;
                else if (match.winner.toString() === match.teamA._id.toString()) winnerName = match.teamA.name;
                else if (match.winner.toString() === match.teamB._id.toString()) winnerName = match.teamB.name;
            }

            const embed = new EmbedBuilder()
                .setColor(0xff4655)
                .setTitle(`🏆 MATCH RESULT: ${match.name}`)
                .setDescription(`**WINNER:** ${winnerName}\n**SERIES:** ${match.teamA.shortName} **${scoreA} - ${scoreB}** ${match.teamB.shortName}`)
                .setTimestamp();

            if (match.scores && match.scores.length > 0) {
                let mapDetails = '';
                let lastProofImage = null;
                match.scores.forEach(s => {
                    let proofUrl = s.proofImage;
                    if (proofUrl && !proofUrl.startsWith('http') && process.env.CLIENT_URL) {
                        proofUrl = new URL(proofUrl, process.env.CLIENT_URL).toString();
                    }
                    const proofLink = (proofUrl && proofUrl.startsWith('http')) ? ` | 📸 Proof` : '';
                    if (proofUrl && proofUrl.startsWith('http')) lastProofImage = proofUrl;
                    mapDetails += `**${s.mapName}**: ${match.teamA.shortName} **${s.teamAScore} - ${s.teamBScore}** ${match.teamB.shortName}${proofLink}\n`;
                });
                embed.addFields({ name: 'Map Scores', value: mapDetails });
                if (lastProofImage) embed.setImage(lastProofImage);
            }

            if (match.discordChannelId) {
                const channel = await this.withRetry(() => this.client.channels.fetch(match.discordChannelId)).catch(() => null);
                if (channel) await this.withRetry(() => channel.send({ embeds: [embed] }));
            }

            const resultsChannelId = process.env.DISCORD_RESULTS_CHANNEL_ID;
            if (resultsChannelId) {
                const resultsChannel = await this.withRetry(() => this.client.channels.fetch(resultsChannelId)).catch(() => null);
                if (resultsChannel) await this.withRetry(() => resultsChannel.send({ embeds: [embed] }));
            }
        } catch (e) { console.error("Error sending match result to Discord:", e); }
    }

    async sendBracketAnnouncement(tournament, stageName, matchCount) {
        if (!this.client) return;
        // Use configured announcement channel or fallback to results channel
        const channelId = process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID || process.env.DISCORD_RESULTS_CHANNEL_ID;
        if (!channelId) return;

        try {
            const channel = await this.withRetry(() => this.client.channels.fetch(channelId)).catch(() => null);
            if (!channel) return;

            const embed = new EmbedBuilder()
                .setColor(0x3498db) // Blue
                .setTitle(`📢 Tournament Update: ${tournament.name}`)
                .setDescription(`**${stageName}** bracket has been generated!`)
                .addFields(
                    { name: 'Matches Created', value: `${matchCount}`, inline: true },
                    { name: 'Status', value: 'Scheduled', inline: true }
                )
                .setTimestamp();

            await this.withRetry(() => channel.send({ embeds: [embed] }));
        } catch (e) { console.error("Error sending bracket announcement:", e); }
    }

    async sendVetoResultToDiscord(match) {
        if (!this.client || !match.discordChannelId) return;
        try {
            const channel = await this.withRetry(() => this.client.channels.fetch(match.discordChannelId)).catch(() => null);
            if (!channel) return;

            let description = "";
            match.vetoData.pickedMaps.forEach((pick, index) => {
                const mapName = pick.map;
                const atkTeam = pick.teamAStartingSide === 'atk' ? match.teamA.shortName : match.teamB.shortName;
                const defTeam = pick.teamAStartingSide === 'def' ? match.teamA.shortName : match.teamB.shortName;
                description += `**Map ${index + 1}: ${mapName}**\n🗡️ Attack: **${atkTeam}**\n🛡️ Defend: **${defTeam}**\n\n`;
            });

            const embed = new EmbedBuilder()
                .setColor(0xe67e22) // Orange
                .setTitle(`🗺️ Veto Completed: ${match.teamA.shortName} vs ${match.teamB.shortName}`)
                .setDescription(description || "No maps picked.")
                .setTimestamp();

            await this.withRetry(() => channel.send({ embeds: [embed] }));
        } catch (e) { console.error("Error sending veto result:", e); }
    }

    async setupDiscordChannels() {
        if (!this.client || !this.guildId) return;
        try {
            const guild = await this.withRetry(() => this.client.guilds.fetch(this.guildId)).catch(() => null);
            if (!guild) return;

            const ensureChannel = async (name, type, envVarName, permissionOverwrites = []) => {
                let channelId = process.env[envVarName];
                let channel;
                if (channelId) channel = await this.withRetry(() => guild.channels.fetch(channelId)).catch(() => null);
                if (!channel) channel = guild.channels.cache.find(c => c.name === name && c.type === type);
                if (!channel) {
                    channel = await this.withRetry(() => guild.channels.create({ name, type, permissionOverwrites }));
                    console.log(`✅ Created #${name} channel: ${channel.id}`);
                }
                process.env[envVarName] = channel.id;
                return channel;
            };

            const verifyChannel = await ensureChannel('verify-role', ChannelType.GuildText, 'DISCORD_CLAIM_CHANNEL_ID', [
                { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }
            ]);
            await ensureChannel('admin-logs', ChannelType.GuildText, 'DISCORD_ADMIN_LOG_CHANNEL_ID', [
                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] } 
            ]);
            await ensureChannel('match-results', ChannelType.GuildText, 'DISCORD_RESULTS_CHANNEL_ID', [
                { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages], allow: [PermissionsBitField.Flags.ViewChannel] }
            ]);

            const messages = await this.withRetry(() => verifyChannel.messages.fetch({ limit: 10 })).catch(() => []);
            const hasButton = messages.some && messages.some(m => m.author.id === this.client.user.id && m.components.length > 0);

            if (!hasButton) {
                const embed = new EmbedBuilder()
                    .setColor(0xff4655)
                    .setTitle('🛡️ TOURNAMENT ROLE CLAIM')
                    .setDescription('Click the button below to verify your registration and claim your Team Role.')
                    .setFooter({ text: 'VCT System' });
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('claim_role').setLabel('Claim Team Role').setStyle(ButtonStyle.Success).setEmoji('🔐')
                );
                await this.withRetry(() => verifyChannel.send({ embeds: [embed], components: [row] }));
            }
        } catch (e) { console.error("❌ Auto-setup Channels Error:", e); }
    }
}

module.exports = new DiscordService();
