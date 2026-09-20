import { canSeek, parseSeek } from "../utils/playback.js";
import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import {
  activePlayerMessages,
  clearAllFilters,
  discordClient,
  lavalink,
  smoothFadePause,
  smoothFadeResume,
  updateActivePlayerMessage,
  validateVoiceGate,
} from "../lavalink/client.js";
import { RepeatMode } from "lavalink-client";
import { autoDeleteReply } from "../utils/cleanup.js";
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

    await smoothFadePause(player);
    await updateActivePlayerMessage(player, true);
    await interaction.reply("⏸️ Playback paused.");
    autoDeleteReply(interaction, 8000);
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

    await smoothFadeResume(player);
    await updateActivePlayerMessage(player, true);
    await interaction.reply("▶️ Playback resumed.");
    autoDeleteReply(interaction, 8000);
  },
};

export const skipCommand = {
  data: new SlashCommandBuilder().setName("skip").setDescription("Skip to the next song in the queue"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    await interaction.deferReply();
    const currentTitle = player.queue.current?.info.title || "Current song";
    try {
      if (player.queue.tracks.length > 0) {
        await player.skip();
      } else {
        await player.stopPlaying();
      }
      await updateActivePlayerMessage(player);
      await interaction.editReply(`⏭️ Skipped **${currentTitle}**`);
      autoDeleteReply(interaction, 8000);
    } catch {
      await player.stopPlaying().catch(() => {});
      await updateActivePlayerMessage(player);
      await interaction.editReply(`⏭️ Skipped **${currentTitle}**`);
      autoDeleteReply(interaction, 8000);
    }
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
    await updateActivePlayerMessage(player);
    await interaction.reply(`⏮️ Playing previous track: **${prevTrack.info.title}**`);
    autoDeleteReply(interaction, 8000);
  },
};

export const stopCommand = {
  data: new SlashCommandBuilder().setName("stop").setDescription("Stop playback, clear queue, and leave voice channel"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player) return interaction.reply({ content: "❌ I'm not currently connected to any voice channel.", ephemeral: true });

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) return interaction.reply({ content: gate.error!, ephemeral: true });

    await clearAllFilters(player).catch(() => {});

    const prevMsgId = activePlayerMessages.get(interaction.guildId!);
    if (prevMsgId && player.textChannelId) {
      const chan = discordClient?.channels.cache.get(player.textChannelId) as TextChannel | undefined;
      if (chan) {
        try {
          const prevMsg = chan.messages.cache.get(prevMsgId) || (await chan.messages.fetch(prevMsgId).catch(() => null));
          if (prevMsg) {
            await prevMsg.edit({
              content: `⏹️ Playback stopped by **${interaction.user.username}**. Equalizer reset to **Normal (Flat)**.`,
              embeds: [],
              components: [],
            }).catch(() => {});
          }
        } catch {}
      }
    }
    activePlayerMessages.delete(interaction.guildId!);

    await player.destroy("User executed stop command");
    await interaction.reply("⏹️ Stopped playback and disconnected from voice. Equalizer reset to **Normal (Flat)**.");
    autoDeleteReply(interaction, 10000);
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
    await updateActivePlayerMessage(player, true);

    const modeLabels: Record<string, string> = {
      off: "➡️ Loop disabled",
      track: "🔂 Looping current track",
      queue: "🔁 Looping entire queue",
    };

    await interaction.reply(modeLabels[mode] || `Loop mode set to ${mode}`);
    autoDeleteReply(interaction, 8000);
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
    await updateActivePlayerMessage(player);
    await interaction.reply(`🔀 Shuffled **${player.queue.tracks.length}** tracks in the queue.`);
    autoDeleteReply(interaction, 8000);
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

    if (!canSeek(player.queue.current)) return interaction.reply({ content: "This stream does not support seeking.", ephemeral: true });
    const targetMs = parseSeek(interaction.options.getString("timestamp", true), player.position || 0, player.queue.current.info.duration);
    if (targetMs === null) return interaction.reply({ content: "Use MM:SS, HH:MM:SS, seconds, or a relative time such as +30.", ephemeral: true });
    await interaction.deferReply();
    await player.seek(targetMs);
    await updateActivePlayerMessage(player, true);
    await interaction.editReply(`⏩ Jumped to **${formatDuration(targetMs)}**`);
    autoDeleteReply(interaction, 8000);
  },
};

export function parseIndicesToRemove(trackInput: string, toInput?: number | null, queueLength = 0): { indices: number[]; error?: string } {
  const indices = new Set<number>();
  const input = toInput != null ? `${trackInput.trim()}-${toInput}` : trackInput.trim().replace(/\s+to\s+/gi, '-').replace(/\s*-\s*/g, '-');
  for (const chunk of input.split(/[,;\s]+/).filter(Boolean)) {
    const match = chunk.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) return { indices: [], error: 'Use track numbers or ranges, such as 1, 3, 5-8.' };
    const from = Number(match[1]), to = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1) {
      return { indices: [], error: 'Track positions must be positive whole numbers.' };
    }
    // Clamp before iterating: enormous input ranges must never block the event loop.
    for (let n = Math.max(1, Math.min(from, to)); n <= Math.min(queueLength, Math.max(from, to)); n++) indices.add(n);
  }
  return indices.size ? { indices: [...indices].sort((a, b) => b - a) }
    : { indices: [], error: `No matching positions in the current queue (${queueLength} tracks).` };
}

export const removeCommand = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove one, multiple, or a range of tracks from the queue")
    .addStringOption((opt) =>
      opt
        .setName("track")
        .setDescription("Track number, comma list, or range (e.g. '3', '1, 3, 5', '2-6', '2 to 6')")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("to")
        .setDescription("Optional end position if removing a range (e.g. track: 2, to: 5)")
        .setRequired(false)
        .setMinValue(1)
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || player.queue.tracks.length === 0) {
      return interaction.respond([]);
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();
    const tracks = player.queue.tracks;

    const choices: { name: string; value: string }[] = [];
    for (let i = 0; i < tracks.length; i++) {
      if (choices.length >= 25) break;
      const t = tracks[i];
      const title = t.info.title.substring(0, 50);
      const author = t.info.author ? ` - ${t.info.author.substring(0, 25)}` : "";
      const dur = t.info.duration ? ` [${formatDuration(t.info.duration)}]` : "";
      const label = `#${i + 1}: ${title}${author}${dur}`.substring(0, 100);

      if (!focusedValue || label.toLowerCase().includes(focusedValue) || `${i + 1}`.startsWith(focusedValue)) {
        choices.push({ name: label, value: `${i + 1}` });
      }
    }

    await interaction.respond(choices);
  },
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    const tracks = player.queue.tracks;
    if (tracks.length === 0) {
      return interaction.reply({
        content: "❌ The queue is empty! There are no upcoming songs to remove.",
        ephemeral: true,
      });
    }

    const trackInput = interaction.options.getString("track", true);
    const toInput = interaction.options.getInteger("to", false);

    const { indices, error } = parseIndicesToRemove(trackInput, toInput, tracks.length);
    if (error || !indices || indices.length === 0) {
      return interaction.reply({
        content: error || `❌ Could not find valid track numbers to remove. Current queue size: **${tracks.length}**.`,
        ephemeral: true,
      });
    }

    const removedNames: string[] = [];
    // indices are sorted descending so splicing from high to low preserves earlier indices
    for (const pos of indices) {
      const idx = pos - 1;
      const t = tracks[idx];
      if (t) {
        removedNames.push(`**#${pos}** ${t.info.title}`);
        tracks.splice(idx, 1);
      }
    }

    await player.queue.utils.save();
    await updateActivePlayerMessage(player);

    if (indices.length === 1) {
      await interaction.reply(`🗑️ Removed ${removedNames[0]} from the queue.`);
      autoDeleteReply(interaction, 8000);
      return;
    }

    const preview = removedNames.slice(0, 4).join("\n");
    const extra = removedNames.length > 4 ? `\n...and ${removedNames.length - 4} more` : "";
    await interaction.reply(`🗑️ Removed **${indices.length}** tracks from the queue:\n${preview}${extra}`);
    autoDeleteReply(interaction, 8000);
  },
};

export const clearCommand = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Clear all upcoming tracks from the queue without stopping current song"),
  async execute(interaction: ChatInputCommandInteraction) {
    const player = await getPlayerWithGate(interaction);
    if (!player) return;

    const count = player.queue.tracks.length;
    if (count === 0) {
      return interaction.reply({
        content: "⚠️ The queue is already empty!",
        ephemeral: true,
      });
    }

    await player.queue.splice(0, count);
    await updateActivePlayerMessage(player);

    await interaction.reply(`🧹 Cleared **${count}** song(s) from the queue.`);
    autoDeleteReply(interaction, 8000);
  },
};

