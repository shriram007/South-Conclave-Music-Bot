import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, } from "discord.js";
import { createProgressBar, getSourceInfo } from "../utils/formatters.js";
import { discordClient } from "./client.js";
/**
 * Builds the interactive player message with embed, action buttons, and sound filter select menu
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
    const isPaused = player.paused;
    const progressBar = createProgressBar(position, duration, 15, isPaused);
    const loopModeDisplay = player.repeatMode === "track"
        ? "🔂 Track"
        : player.repeatMode === "queue"
            ? "🔁 Queue"
            : "Off";
    const volume = player.volume;
    let volEmoji = "🔊";
    if (volume === 0)
        volEmoji = "🔇";
    else if (volume < 50)
        volEmoji = "🔉";
    const isFilterActive = Boolean(player.getData("hifi_active"));
    const activePresetKey = player.getData("filter_preset_key") || (isFilterActive ? "hifi" : "reset");
    const eqPreset = player.getData("eq_preset") || (isFilterActive ? "💎 Hi-Fi Studio" : "Normal (Flat)");
    const requester = current.requester;
    const requesterId = requester?.id || current.userData?.userId || (typeof requester === "string" ? requester : null);
    const requesterDisplay = requesterId ? `<@${requesterId}>` : (requester?.username || "Server Member");
    const botAvatar = discordClient?.user?.displayAvatarURL({ extension: "png", size: 128 });
    // Dynamic header status
    let statusHeader = isPaused ? "⏸️ Paused" : "▶️ Now Playing";
    const speed = player.filterManager?.data?.timescale?.speed || 1.0;
    if (!isPaused && speed > 1.1) {
        statusHeader = `🏎️ Playing (${speed}x Turbo)`;
    }
    else if (!isPaused && activePresetKey === "nightcore") {
        statusHeader = "⚡ Playing (Nightcore)";
    }
    else if (!isPaused && activePresetKey === "8d") {
        statusHeader = "🎧 Playing (8D Audio)";
    }
    const queueCount = player.queue.tracks.length;
    const queueLabel = queueCount === 0 ? "Empty" : `${queueCount} track${queueCount > 1 ? "s" : ""}`;
    const embed = new EmbedBuilder()
        .setColor(source.color)
        .setAuthor({
        name: `${statusHeader} • ${source.name}`,
        ...(botAvatar ? { iconURL: botAvatar } : {}),
        url: current.info.uri || undefined,
    })
        .setTitle(current.info.title.substring(0, 256))
        .setURL(current.info.uri || "https://discord.com")
        .setDescription(`👤 **Artist:** \`${current.info.author || "Unknown"}\`\n` +
        `⚡ **Source:** ${source.badge}\n\n` +
        `${progressBar}\n\n` +
        `${volEmoji} **Vol:** \`${volume}%\` • 🔁 **Loop:** \`${loopModeDisplay}\` • 🎛️ **Preset:** \`${eqPreset}\`\n` +
        `📑 **Queue:** \`${queueLabel}\` • 👤 **Requested by:** ${requesterDisplay}`)
        .setFooter({
        text: "💎 South Conclave Audiophile Engine • Live Interactive Player",
    })
        .setTimestamp();
    if (current.info.artworkUrl) {
        embed.setThumbnail(current.info.artworkUrl);
    }
    // Row 1: Core playback & navigation
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_prev")
        .setEmoji("⏮️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(player.queue.previous.length === 0), new ButtonBuilder()
        .setCustomId("player_pause_resume")
        .setEmoji(isPaused ? "▶️" : "⏸️")
        .setLabel(isPaused ? "Resume" : "Pause")
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary), new ButtonBuilder()
        .setCustomId("player_skip")
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_shuffle")
        .setEmoji("🔀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(queueCount < 2), new ButtonBuilder()
        .setCustomId("player_stop")
        .setEmoji("⏹️")
        .setStyle(ButtonStyle.Danger));
    // Row 2: Secondary Controls (Volume, Loop, Queue view with live count, Lyrics)
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_voldown")
        .setEmoji("🔉")
        .setLabel("-10%")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(volume <= 0), new ButtonBuilder()
        .setCustomId("player_volup")
        .setEmoji("🔊")
        .setLabel("+10%")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(volume >= 200), new ButtonBuilder()
        .setCustomId("player_loop")
        .setEmoji(player.repeatMode === "track" ? "🔂" : "🔁")
        .setLabel(loopModeDisplay)
        .setStyle(player.repeatMode !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_queue")
        .setEmoji("📋")
        .setLabel(`Queue (${queueCount})`)
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_lyrics")
        .setEmoji("📜")
        .setLabel("Lyrics")
        .setStyle(ButtonStyle.Secondary));
    // Row 3: Interactive Filter / EQ Select Menu (with active preset marked default)
    const filterOptions = [
        { label: "Hi-Fi Studio (Audiophile Sparkle)", value: "hifi", emoji: "💎", description: "Studio clarity & dynamics" },
        { label: "Bass Boost", value: "bassboost", emoji: "🔊", description: "Punchy deep sub-bass" },
        { label: "Turbo Rush (1.35x)", value: "turbo", emoji: "🏎️", description: "High-tempo workout/gaming boost" },
        { label: "Vocal / Treble Boost", value: "treble", emoji: "🎤", description: "Crisp acoustic highs & clarity" },
        { label: "8D Audio", value: "8d", emoji: "🎧", description: "Rotating 360° binaural immersion" },
        { label: "Nightcore", value: "nightcore", emoji: "⚡", description: "Fast tempo & pitch boost" },
        { label: "Vaporwave", value: "vaporwave", emoji: "🌊", description: "Slowed & relaxed aesthetic" },
        { label: "Karaoke (Sing-Along)", value: "karaoke", emoji: "🎤", description: "Suppresses vocals for sing-along" },
        { label: "Reset to Flat / Pure Audio", value: "reset", emoji: "🔄", description: "Pristine lossless studio audio" },
    ].map((opt) => ({
        ...opt,
        default: opt.value === activePresetKey,
    }));
    const row3 = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId("player_filter_menu")
        .setPlaceholder("🎛️ Select Sound Filter or Equalizer Preset...")
        .addOptions(filterOptions));
    return {
        embeds: [embed],
        components: [row1, row2, row3],
    };
}
