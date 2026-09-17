import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { getChannelBitrateInfo, getSourceInfo } from "../utils/formatters.js";
export const qualityCommand = {
    data: new SlashCommandBuilder()
        .setName("quality")
        .setDescription("Inspect audio bitrate, server boost tier, and studio playback fidelity"),
    async execute(interaction) {
        const member = interaction.member;
        const voiceChannel = member?.voice?.channel;
        const player = lavalink.getPlayer(interaction.guildId);
        const current = player?.queue.current;
        const currentSrc = current ? getSourceInfo(current.info.sourceName) : null;
        const embed = new EmbedBuilder()
            .setColor(0x00d26a)
            .setTitle("💎 Studio Audio Quality & Bitrate Inspector")
            .setDescription("To get **Apple Music / Spotify 300+ kbps playback quality** in Discord, both the **Audio Engine** and the **Discord Voice Channel** must be running at maximum bitrate.");
        if (voiceChannel) {
            const info = getChannelBitrateInfo(voiceChannel);
            embed.addFields([
                {
                    name: "🔊 Current Voice Channel Bitrate",
                    value: `**${info.bitrateKbps} kbps** (${info.tier})`,
                    inline: true,
                },
                {
                    name: "🎯 Maximum Bitrate For Server",
                    value: info.isMaxQuality ? "✅ **Set to Maximum**" : "⚠️ **Can be increased**",
                    inline: true,
                },
            ]);
            embed.addFields([
                {
                    name: "💡 Optimization Tip",
                    value: info.recommendation,
                    inline: false,
                },
            ]);
        }
        else {
            embed.addFields([
                {
                    name: "🔊 Voice Channel",
                    value: "Connect to a voice channel to inspect its exact live bitrate.",
                    inline: false,
                },
            ]);
        }
        // Engine & Source Specs
        embed.addFields([
            {
                name: "🎛️ Audio Engine Pipeline",
                value: "• **Codec:** Opus Stereo (48,000 Hz Native)\n" +
                    "• **Resampling Quality:** Highest (libsamplerate)\n" +
                    "• **Opus Complexity:** Level 10 (Maximum studio fidelity)\n" +
                    "• **Jitter Buffer:** 5000ms studio pre-buffering (Zero stutter)",
                inline: false,
            },
            {
                name: "🎵 Current Track Source",
                value: currentSrc
                    ? `${currentSrc.badge}\n• Stream Rate: **${currentSrc.quality}**`
                    : "No track currently playing. Use `/play` to start.",
                inline: false,
            },
            {
                name: "🚀 Discord Server Boost Bitrate Tiers",
                value: "• **Free / Standard:** Up to `96 kbps`\n" +
                    "• **Tier 1 (2 Boosts):** Up to `128 kbps`\n" +
                    "• **Tier 2 (7 Boosts):** Up to `256 kbps`\n" +
                    "• **Tier 3 (14 Boosts) / Partnered:** Up to `384 kbps` *(True Studio Hi-Fi)*",
                inline: false,
            },
        ]);
        embed.setFooter({
            text: "How to increase bitrate: Right click Voice Channel → Edit Channel → Overview → Bitrate slider",
        });
        return interaction.reply({ embeds: [embed] });
    },
};
