import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, } from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { is247Enabled, set247 } from "../utils/twentyFourSeven.js";
export const twentyFourSevenCommand = {
    data: new SlashCommandBuilder()
        .setName("247")
        .setDescription("Toggle 24/7 Mode to keep the bot in the voice channel permanently")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    async execute(interaction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            return interaction.reply({ content: "❌ This command can only be used in a server!", ephemeral: true });
        }
        // Check admin permission
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({
                content: "❌ You need **Manage Server** or **Administrator** permission to toggle 24/7 mode!",
                ephemeral: true,
            });
        }
        const member = interaction.member;
        const memberVoice = member?.voice?.channel;
        const botMember = interaction.guild?.members.me;
        const currentVoiceId = botMember?.voice?.channelId || memberVoice?.id;
        if (!currentVoiceId) {
            return interaction.reply({
                content: "❌ You must either be in a voice channel or connect the bot first with `/play`!",
                ephemeral: true,
            });
        }
        const currentlyEnabled = is247Enabled(guildId);
        if (currentlyEnabled) {
            // Disable 24/7 mode
            set247(guildId, false);
            const embed = new EmbedBuilder()
                .setColor(0xed4245)
                .setTitle("🔴 24/7 Mode Disabled")
                .setDescription("The bot will now leave the voice channel normally when the queue finishes or when idle.");
            return interaction.reply({ embeds: [embed] });
        }
        else {
            // Enable 24/7 mode
            // Make sure bot is connected
            let player = lavalink.getPlayer(guildId);
            if (!player) {
                player = lavalink.createPlayer({
                    guildId,
                    voiceChannelId: currentVoiceId,
                    textChannelId: interaction.channelId,
                    selfDeaf: true,
                    selfMute: false,
                    volume: 100,
                    instaUpdateFiltersFix: true,
                    applyVolumeAsFilter: false,
                });
            }
            if (!player.connected) {
                await player.connect();
            }
            set247(guildId, true, currentVoiceId, interaction.channelId);
            const embed = new EmbedBuilder()
                .setColor(0x00d26a)
                .setTitle("🟢 24/7 Mode Enabled!")
                .setDescription(`**South Conclave Music Bot** will now stay in <#${currentVoiceId}> **24/7**!\n\n` +
                `• It will **never** leave when songs end.\n` +
                `• It will **never** leave when users leave.\n` +
                `• It will **automatically reconnect** if the bot restarts!`)
                .setFooter({ text: "Use /247 again anytime to disable." });
            return interaction.reply({ embeds: [embed] });
        }
    },
};
