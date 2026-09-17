import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { RepeatMode } from "lavalink-client";
import { formatDuration } from "../utils/formatters.js";

async function getPlayerWithGate(interaction: ChatInputCommandInteraction) {
  const player = lavalink.getPlayer(interaction.guildId!);
  if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
    await interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
    return null;
  }

  const gate = await validateVoiceGate(interaction, player);
  if (!gate.allowed) {
    await interaction.reply({ content: gate.error!, ephemeral: true });
    return null;
  }

  return player;
}

export const pauseCommand = {
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause current playback"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    if (player.paused) {
      return interaction.reply({ content: "⚠️ Playback is already paused! Use `/resume` to unpause.", ephemeral: true });
    }

    await player.pause();
    await updateActivePlayerMessage(player);
    return interaction.reply("⏸️ Playback paused.");
  },
};

export const resumeCommand = {
  data: new SlashCommandBuilder().setName("resume").setDescription("Resume paused playback"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    if (!player.paused) {
      return interaction.reply({ content: "⚠️ Playback is already playing!", ephemeral: true });
    }

    await player.resume();
    await updateActivePlayerMessage(player);
    return interaction.reply("▶️ Playback resumed.");
  },
};

export const skipCommand = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Skip to the next song in the queue"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    const currentTitle = player.queue.current?.info.title || "Current song";
    await player.skip();
    return interaction.reply(`⏭️ Skipped **${currentTitle}**`);
  },
};

export const previousCommand = {
  data: new SlashCommandBuilder().setName("previous").setDescription("Play the previous track"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    if (player.queue.previous.length === 0) {
      return interaction.reply({ content: "⚠️ No previous songs in history.", ephemeral: true });
    }

    const prevTrack = player.queue.previous[0];
    await player.queue.add(prevTrack, 0);
    await player.skip();
    return interaction.reply(`⏮️ Playing previous track: **${prevTrack.info.title}**`);
  },
};

export const stopCommand = {
  data: new SlashCommandBuilder().setName("stop").setDescription("Stop playback, clear queue, and leave voice channel"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player) return interaction.reply({ content: "❌ I'm not currently connected to any voice channel.", ephemeral: true });

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) return interaction.reply({ content: gate.error!, ephemeral: true });

    await player.filterManager.resetFilters().catch(() => {});
    player.setData("hifi_active", false);
    player.setData("eq_preset", "Normal (Flat)");
    await player.destroy("User executed stop command");
    return interaction.reply("⏹️ Stopped playback and disconnected from voice. Equalizer reset to **Normal (Flat)**.");
  },
};

export const loopCommand = {
  data: new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Set repeat mode (off, track, queue)")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Repeat mode")
        .setRequired(true)
        .addChoices(
          { name: "Off", value: "off" },
          { name: "Track (Repeat Current Song)", value: "track" },
          { name: "Queue (Repeat Entire Queue)", value: "queue" }
        )
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    const mode = interaction.options.getString("mode", true) as RepeatMode;
    await player.setRepeatMode(mode);
    await updateActivePlayerMessage(player);

    const modeLabels: Record<string, string> = {
      off: "➡️ Loop disabled",
      track: "🔂 Looping current track",
      queue: "🔁 Looping entire queue",
    };

    return interaction.reply(modeLabels[mode] || `Loop mode set to ${mode}`);
  },
};

export const shuffleCommand = {
  data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the remaining queue"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    if (player.queue.tracks.length < 2) {
      return interaction.reply({ content: "⚠️ Need at least 2 tracks in queue to shuffle.", ephemeral: true });
    }

    await player.queue.shuffle();
    return interaction.reply(`🔀 Shuffled **${player.queue.tracks.length}** tracks in the queue.`);
  },
};

export const seekCommand = {
  data: new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Seek to a specific timestamp in the current song")
    .addStringOption((opt) =>
      opt.setName("timestamp").setDescription("Target time (e.g. 1:30, 02:45, or seconds like 90)").setRequired(true)
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player || !player.queue.current) return;

    const timeStr = interaction.options.getString("timestamp", true).trim();
    let targetMs = 0;

    if (timeStr.includes(":")) {
      const parts = timeStr.split(":").map(Number);
      if (parts.some(isNaN)) {
        return interaction.reply({ content: "❌ Invalid time format! Use `MM:SS` or `HH:MM:SS`.", ephemeral: true });
      }
      if (parts.length === 2) {
        targetMs = (parts[0] * 60 + parts[1]) * 1000;
      } else if (parts.length === 3) {
        targetMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      }
    } else {
      const sec = parseFloat(timeStr);
      if (isNaN(sec)) {
        return interaction.reply({ content: "❌ Invalid timestamp number!", ephemeral: true });
      }
      targetMs = sec * 1000;
    }

    const duration = player.queue.current.info.duration;
    if (targetMs < 0 || (duration > 0 && targetMs > duration)) {
      return interaction.reply({
        content: `❌ Timestamp must be between 00:00 and ${formatDuration(duration)}!`,
        ephemeral: true,
      });
    }

    await player.seek(targetMs);
    return interaction.reply(`⏩ Jumped to **${formatDuration(targetMs)}**`);
  },
};
