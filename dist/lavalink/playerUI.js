import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, } from "discord.js";
import { createFlaviProgressBar, getSourceInfo } from "../utils/formatters.js";
import { isFavorite } from "../utils/favorites.js";
import { discordClient } from "./client.js";
/**
 * Builds the interactive player message matching FlaviBot layout
 */
export function buildPlayerMessage(player, track) {
    const current = track || player.queue.current;
    if (!current) {
        const emptyEmbed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setDescription("🎵 No song currently playing.");
        return { embeds: [emptyEmbed], components: [] };
    }
    const source = getSourceInfo(current.info.sourceName);
    const position = player.position || 0;
    const duration = current.info.duration || 0;
    const isPaused = player.paused;
    const progressBar = createFlaviProgressBar(position, duration, 24);
    const loopModeDisplay = player.repeatMode === "track"
        ? "Track"
        : player.repeatMode === "queue"
            ? "Queue"
            : "Off";
    const volume = player.volume;
    const isFilterActive = Boolean(player.getData("hifi_active"));
    const activePresetKey = player.getData("filter_preset_key") || (isFilterActive ? "hifi" : "reset");
    const isAutoplay = Boolean(player.getData("autoplay") ?? true);
    const requester = current.requester;
    const requesterId = requester?.id || current.userData?.userId || (typeof requester === "string" ? requester : null);
    const requesterDisplay = requesterId ? `<@${requesterId}>` : (requester?.username ? `@${requester.username}` : "Server Member");
    const isLiked = requesterId ? isFavorite(requesterId, current.info.uri) : false;
    const botAvatar = discordClient?.user?.displayAvatarURL({ extension: "png", size: 128 });
    const queueCount = player.queue.tracks.length;
    const safeTitle = current.info.title.substring(0, 200).replace(/\[/g, "\\[").replace(/\]/g, "\\]");
    const vcMention = player.voiceChannelId ? `<#${player.voiceChannelId}>` : "Voice Channel";
    // FlaviBot Accent: #5865F2 (Royal Blurple)
    const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setDescription(`### Now playing\n` +
        `---\n` +
        `## [${safeTitle}](${current.info.uri || "https://discord.com"})\n` +
        `• **Added by** ${requesterDisplay}\n` +
        `• **Voice Channel:** ${vcMention}\n\n` +
        `Queue Size: \`${queueCount}\` · Volume: \`${volume}%\` · Loop: \`${loopModeDisplay}\`\n\n` +
        `${progressBar}`)
        .setFooter({
        text: `South Conclave Audiophile Engine • Fidelity: ${source.name}`,
        ...(botAvatar ? { iconURL: botAvatar } : {}),
    })
        .setTimestamp();
    if (current.info.artworkUrl) {
        embed.setThumbnail(current.info.artworkUrl);
    }
    // Row 1: Primary Controls (Pause/Resume, Skip, Seek, Stop, Like)
    const row1 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_pause_resume")
        .setEmoji(isPaused ? "▶️" : "⏸️")
        .setLabel(isPaused ? "Resume" : "Pause")
        .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_skip")
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_seek")
        .setEmoji("⏩")
        .setLabel("Seek")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_stop")
        .setEmoji("⏹️")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_like")
        .setEmoji(isLiked ? "❤️" : "🤍")
        .setLabel(isLiked ? "Liked" : "Like")
        .setStyle(isLiked ? ButtonStyle.Success : ButtonStyle.Secondary));
    // Row 2: Secondary Utilities (AutoPlay, Dashboard/Queue, Hi-Fi EQ, Lyrics, Prev)
    const row2 = new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId("player_autoplay")
        .setEmoji("🔄")
        .setLabel(isAutoplay ? "AutoPlay: ON" : "AutoPlay")
        .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_queue")
        .setEmoji("📋")
        .setLabel(`Queue (${queueCount})`)
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_hifieq")
        .setEmoji("💎")
        .setLabel("Hi-Fi EQ")
        .setStyle(isFilterActive ? ButtonStyle.Success : ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_lyrics")
        .setEmoji("📜")
        .setLabel("Lyrics")
        .setStyle(ButtonStyle.Secondary), new ButtonBuilder()
        .setCustomId("player_prev")
        .setEmoji("⏮️")
        .setLabel("Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(player.queue.previous.length === 0));
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
