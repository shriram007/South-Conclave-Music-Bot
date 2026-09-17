import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { Player, Track } from "lavalink-client";
import { createProgressBar, formatDuration, getSourceInfo } from "../utils/formatters.js";
import { discordClient } from "./client.js";

export interface PlayerMessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<any>[];
}

/**
 * Builds the interactive player message with embed, action buttons, and sound filter select menu
 */
export function buildPlayerMessage(player: Player, track?: Track | null): PlayerMessagePayload {
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

  const loopModeDisplay =
    player.repeatMode === "track"
      ? "🔂 Track"
      : player.repeatMode === "queue"
      ? "🔁 Queue"
      : "Off";

  const isPaused = player.paused;
  const volume = player.volume;
  const isFilterActive = Boolean(player.getData("hifi_active"));
  const eqPreset = (player.getData("eq_preset") as string) || (isFilterActive ? "💎 Hi-Fi Studio" : "Normal (Flat)");

  const requester = current.requester as any;
  const requesterId = requester?.id || (current.userData as any)?.userId || (typeof requester === "string" ? requester : null);
  const requesterDisplay = requesterId ? `<@${requesterId}>` : (requester?.username || "Server Member");

  const botAvatar = discordClient?.user?.displayAvatarURL({ extension: "png", size: 128 });

  const embed = new EmbedBuilder()
    .setColor(source.color)
    .setAuthor({
      name: `Now Playing • ${source.name}`,
      ...(botAvatar ? { iconURL: botAvatar } : {}),
      url: current.info.uri || undefined,
    })
    .setTitle(current.info.title.substring(0, 256))
    .setURL(current.info.uri || "https://discord.com")
    .setDescription(
      `👤 **Artist:** \`${current.info.author || "Unknown"}\`\n` +
      `⚡ **Source:** ${source.badge}\n\n` +
      `${progressBar}\n\n` +
      `🔊 **Vol:** \`${volume}%\` • 🔁 **Loop:** \`${loopModeDisplay}\` • 🎛️ **Preset:** \`${eqPreset}\`\n` +
      `📑 **Queue:** \`${player.queue.tracks.length} track(s)\` • 👤 **Requested by:** ${requesterDisplay}`
    )
    .setFooter({
      text: "💎 South Conclave Audiophile Engine • Use buttons & dropdown below",
    })
    .setTimestamp();

  if (current.info.artworkUrl) {
    embed.setThumbnail(current.info.artworkUrl);
  }

  // Row 1: Core playback & navigation
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("player_prev")
      .setEmoji("⏮️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.previous.length === 0),
    new ButtonBuilder()
      .setCustomId("player_pause_resume")
      .setEmoji(isPaused ? "▶️" : "⏸️")
      .setLabel(isPaused ? "Play" : "Pause")
      .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("player_skip")
      .setEmoji("⏭️")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player_shuffle")
      .setEmoji("🔀")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(player.queue.tracks.length < 2),
    new ButtonBuilder()
      .setCustomId("player_stop")
      .setEmoji("⏹️")
      .setStyle(ButtonStyle.Danger)
  );

  // Row 2: Secondary Controls (Volume, Loop, Queue view, Lyrics)
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("player_voldown")
      .setEmoji("🔉")
      .setLabel("-10%")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player_volup")
      .setEmoji("🔊")
      .setLabel("+10%")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player_loop")
      .setEmoji("🔁")
      .setLabel(loopModeDisplay)
      .setStyle(player.repeatMode !== "off" ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player_queue")
      .setEmoji("📋")
      .setLabel("Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("player_lyrics")
      .setEmoji("📜")
      .setLabel("Lyrics")
      .setStyle(ButtonStyle.Secondary)
  );

  // Row 3: Interactive Filter / EQ Select Menu (Flavi-style dropdown)
  const row3 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("player_filter_menu")
      .setPlaceholder("🎛️ Select Sound Filter or Equalizer Preset...")
      .addOptions([
        { label: "Hi-Fi Studio (Audiophile Sparkle)", value: "hifi", emoji: "💎", description: "Studio clarity & dynamics" },
        { label: "Bass Boost", value: "bassboost", emoji: "🔊", description: "Punchy deep sub-bass" },
        { label: "Nuclear Bass", value: "nuclear", emoji: "💥", description: "Extreme ear-rattling sub rumble" },
        { label: "Vocal / Treble Boost", value: "treble", emoji: "🎤", description: "Crisp acoustic highs & clarity" },
        { label: "8D Audio", value: "8d", emoji: "🎧", description: "Rotating 360° binaural immersion" },
        { label: "Nightcore", value: "nightcore", emoji: "⚡", description: "Fast tempo & pitch boost" },
        { label: "Vaporwave", value: "vaporwave", emoji: "🌊", description: "Slowed & relaxed aesthetic" },
        { label: "Chipmunk Mode", value: "chipmunk", emoji: "🐿️", description: "Funny high-pitched squeak" },
        { label: "Robot / Synth", value: "robot", emoji: "🤖", description: "Metallic ring-modulator effect" },
        { label: "Drunk / Dizzy", value: "wobbly", emoji: "🌀", description: "Psychedelic pitch wobble" },
        { label: "Karaoke (Vocal Reducer)", value: "karaoke", emoji: "🎤", description: "Suppresses vocals for sing-along" },
        { label: "Next Room / Party", value: "muffled", emoji: "🚪", description: "Muffled outside club hallway" },
        { label: "1920s Vintage Radio", value: "radio", emoji: "☎️", description: "Lo-fi telephone / antique AM" },
        { label: "Underwater", value: "underwater", emoji: "🤿", description: "Submerged bubbly tone" },
        { label: "Megaphone", value: "megaphone", emoji: "📢", description: "Loud street PA horn speaker" },
        { label: "Turbo Rush (1.35x)", value: "turbo", emoji: "🏎️", description: "High-tempo workout/gaming boost" },
        { label: "Reset to Flat / Pure Audio", value: "reset", emoji: "🔄", description: "Pristine lossless studio audio" },
      ])
  );

  return {
    embeds: [embed],
    components: [row1, row2, row3],
  };
}
