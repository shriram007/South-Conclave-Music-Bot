import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, } from "discord.js";
import { createProgressBar, getSourceInfo } from "../utils/formatters.js";
import { discordClient } from "./client.js";
/**
 * Builds the interactive player message with embed and button controls
 */
export function buildPlayerMessage(player, track) {
    const current = track || player.queue.current;
    if (!current) {
        const emptyEmbed = new EmbedBuilder()
            .setColor(0x2b2d31)
            .setDescription("🎵 No song currently playing.");
        return { embeds: [emptyEmbed], components: [] };
    }
    const source = getSourceInfo(current.info.sourceName);
    const position = player.position || 0;
    const duration = current.info.duration || 0;
    const progressBar = createProgressBar(position, duration);
    const loopModeDisplay = player.repeatMode === "track"
        ? "🔂 Track"
        : player.repeatMode === "queue"
            ? "🔁 Queue"
            : "Off";
    const isPaused = player.paused;
    const volume = player.volume;
    const isFilterActive = Boolean(player.getData("hifi_active"));
    const eqPreset = player.getData("eq_preset") || (isFilterActive ? "💎 Hi-Fi Studio" : "Normal (Flat)");
    const requester = current.requester;
    const requesterId = requester?.id || current.userData?.userId || (typeof requester === "string" ? requester : null);
    const requesterDisplay = requesterId ? `<@${requesterId}>` : (requester?.username || "Server Member");
    const botAvatar = discordClient?.user?.displayAvatarURL({ extension: "png", size: 128 });
    const embed = new EmbedBuilder()
        .setColor(source.color)
        .setAuthor({
        name: "🎧 Now Playing — Studio Audiophile Playback",
        ...(botAvatar ? { iconURL: botAvatar } : {}),
    })
        .setTitle(current.info.title.substring(0, 256))
        .setURL(current.info.uri || "https://discord.com")
        .setDescription(`**Artist:** ${current.info.author}\n` +
        `**Source Quality:** ${source.badge}\n\n` +
        `${progressBar}\n`)
        .addFields([
        { name: "Requested By", value: requesterDisplay, inline: true },
        { name: "Volume", value: `🔊 ${volume}%`, inline: true },
        { name: "Loop Mode", value: loopModeDisplay, inline: true },
        { name: "Queue", value: `${player.queue.tracks.length} track(s)`, inline: true },
        { name: "Equalizer", value: eqPreset, inline: true },
        { name: "Bitrate Target", value: "⚡ 300+ kbps", inline: true },
    ])
        .setFooter({
        text: "💎 Pure 48kHz Opus Stream | Use /quality to check channel bitrate",
    })
        .setTimestamp();
    if (current.info.artworkUrl) {
        embed.setThumbnail(current.info.artworkUrl);
    }
    // Row 1: Core playback & seek controls (5 buttons max)
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_prev")
        .setEmoji("⏮️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(player.queue.previous.length === 0), new ButtonBuilder()
        .setCustomId("player_rewind_10")
        .setEmoji("⏪")
        .setLabel("-10s")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_pause_resume")
        .setEmoji(isPaused ? "▶️" : "⏸️")
        .setLabel(isPaused ? "Resume" : "Pause")
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary), new ButtonBuilder()
        .setCustomId("player_forward_10")
        .setEmoji("⏩")
        .setLabel("+10s")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_skip")
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary));
    // Row 2: Secondary controls (Loop, Shuffle, Volume, HiFi EQ)
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_loop")
        .setEmoji("🔁")
        .setLabel(`Loop: ${loopModeDisplay}`)
        .setStyle(player.repeatMode !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_shuffle")
        .setEmoji("🔀")
        .setLabel("Shuffle")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(player.queue.tracks.length < 2), new ButtonBuilder()
        .setCustomId("player_voldown")
        .setEmoji("🔉")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_volup")
        .setEmoji("🔊")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_hifieq")
        .setEmoji("💎")
        .setLabel(isFilterActive ? "Hi-Fi: ON" : "Hi-Fi: OFF")
        .setStyle(isFilterActive ? ButtonStyle.Success : ButtonStyle.Secondary));
    // Row 3: Stop & extended seek
    const row3 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_rewind_30")
        .setEmoji("⏪")
        .setLabel("-30s")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_forward_30")
        .setEmoji("⏩")
        .setLabel("+30s")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_stop")
        .setEmoji("⏹️")
        .setLabel("Stop & Leave")
        .setStyle(ButtonStyle.Danger));
    return {
        embeds: [embed],
        components: [row1, row2, row3],
    };
}
