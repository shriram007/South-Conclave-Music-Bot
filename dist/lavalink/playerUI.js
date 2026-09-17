import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, } from "discord.js";
import { createProgressBar, getSourceInfo } from "../utils/formatters.js";
import { discordClient } from "./client.js";
/**
 * Builds the interactive Spotify / Flavi player message
 */
export function buildPlayerMessage(player, track) {
    const current = track || player.queue.current;
    if (!current) {
        const emptyEmbed = new EmbedBuilder()
            .setColor(0x121212)
            .setDescription("🎵 No song currently playing.");
        return { embeds: [emptyEmbed], components: [] };
    }
    const source = getSourceInfo(current.info.sourceName);
    const position = player.position || 0;
    const duration = current.info.duration || 0;
    const isPaused = player.paused;
    const progressBar = createProgressBar(position, duration, 15, isPaused);
    const loopModeDisplay = player.repeatMode === "track"
        ? "Track"
        : player.repeatMode === "queue"
            ? "Queue"
            : "Off";
    const loopButtonLabel = player.repeatMode === "track"
        ? "Loop: 1"
        : player.repeatMode === "queue"
            ? "Loop: All"
            : "Loop";
    const volume = player.volume;
    const isFilterActive = Boolean(player.getData("hifi_active"));
    const activePresetKey = player.getData("filter_preset_key") || (isFilterActive ? "hifi" : "reset");
    const eqPreset = player.getData("eq_preset") || (isFilterActive ? "💎 Hi-Fi Studio" : "Flat (Pure)");
    const isAutoplay = Boolean(player.getData("autoplay") ?? true);
    const requester = current.requester;
    const requesterId = requester?.id || current.userData?.userId || (typeof requester === "string" ? requester : null);
    const requesterDisplay = requesterId ? `<@${requesterId}>` : (requester?.username ? `@${requester.username}` : "Server Member");
    const botAvatar = discordClient?.user?.displayAvatarURL({ extension: "png", size: 128 });
    // Dynamic Spotify-inspired status pill
    let statusBadge = isPaused ? "⏸️ PAUSED" : "🟢 NOW PLAYING";
    const speed = player.filterManager?.data?.timescale?.speed || 1.0;
    if (!isPaused && speed > 1.1) {
        statusBadge = `🏎️ PLAYING (${speed}x TURBO)`;
    }
    else if (!isPaused && activePresetKey === "nightcore") {
        statusBadge = "⚡ NIGHTCORE ACTIVE";
    }
    else if (!isPaused && activePresetKey === "8d") {
        statusBadge = "🎧 8D SURROUND ACTIVE";
    }
    const queueCount = player.queue.tracks.length;
    const safeTitle = current.info.title.substring(0, 200).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    const author = (current.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim();
    const vcMention = player.voiceChannelId ? `<#${player.voiceChannelId}>` : "Voice Channel";
    // Spotify Brand Green: 0x1db954, or source color
    const embedColor = source.name.toLowerCase().includes("spotify") ? 0x1db954 : (source.color || 0x1db954);
    const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setAuthor({
        name: `${statusBadge} • ${source.name.toUpperCase()}`,
        ...(botAvatar ? { iconURL: botAvatar } : {}),
        url: current.info.uri || undefined,
    })
        .setDescription(`## [${safeTitle}](${current.info.uri || "https://discord.com"})\n` +
        `**Artist:** \`${author}\` · **Fidelity:** ${source.badge}\n\n` +
        `${progressBar}\n\n` +
        `📻 **Autoplay:** \`${isAutoplay ? "ON" : "OFF"}\` · 🔁 **Loop:** \`${loopModeDisplay}\` · 🎚️ **Vol:** \`${volume}%\` · 💎 **EQ:** \`${eqPreset}\`\n` +
        `👤 **Requested by:** ${requesterDisplay} · **Channel:** ${vcMention}`)
        .setFooter({
        text: `Queue: ${queueCount} upcoming • South Conclave Spotify Player`,
    })
        .setTimestamp();
    if (current.info.artworkUrl) {
        embed.setThumbnail(current.info.artworkUrl);
    }
    // Row 1: Spotify Core Playback Controls (Prev, Play/Pause, Skip, Loop, Shuffle)
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_prev")
        .setEmoji("⏮️")
        .setLabel("Prev")
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
        .setCustomId("player_loop")
        .setEmoji(player.repeatMode === "track" ? "🔂" : "🔁")
        .setLabel(loopButtonLabel)
        .setStyle(player.repeatMode !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_shuffle")
        .setEmoji("🔀")
        .setLabel("Shuffle")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(queueCount < 2));
    // Row 2: Spotify App Utilities (Like, Autoplay Radio, Hi-Fi EQ, Lyrics, Stop)
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_like")
        .setEmoji("❤️")
        .setLabel("Like")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_autoplay")
        .setEmoji("📻")
        .setLabel(`Autoplay: ${isAutoplay ? "ON" : "OFF"}`)
        .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_hifieq")
        .setEmoji("💎")
        .setLabel("Hi-Fi EQ")
        .setStyle(isFilterActive ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_lyrics")
        .setEmoji("📜")
        .setLabel("Lyrics")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_stop")
        .setEmoji("⏹️")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger));
    // Row 3: Interactive Sound Filter & Equalizer Select Menu
    const filterOptions = [
        { label: "Hi-Fi Studio (Audiophile Sparkle)", value: "hifi", emoji: "💎", description: "Studio clarity, sparkle & dynamics" },
        { label: "Bass Boost (Deep Punch)", value: "bassboost", emoji: "🔊", description: "Rich, punchy sub-bass boost" },
        { label: "8D Audio (360° Surround)", value: "8d", emoji: "🎧", description: "Rotating binaural spatial sound" },
        { label: "Nightcore (Speed & Pitch)", value: "nightcore", emoji: "⚡", description: "Fast tempo & pitch uplift" },
        { label: "Vaporwave (Slowed & Reverb)", value: "vaporwave", emoji: "🌊", description: "Slowed, chilled aesthetic" },
        { label: "Turbo Rush (1.35x Workout)", value: "turbo", emoji: "🏎️", description: "High-tempo gaming/workout boost" },
        { label: "Vocal / Treble Boost", value: "treble", emoji: "🎤", description: "Crisp acoustic highs & clarity" },
        { label: "Karaoke (Sing-Along)", value: "karaoke", emoji: "🎤", description: "Suppresses vocals for sing-along" },
        { label: "Flat / Pure Audio (Reset)", value: "reset", emoji: "🔄", description: "Pristine untouched lossless master" },
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
