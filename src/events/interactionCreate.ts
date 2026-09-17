import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Interaction,
  StringSelectMenuInteraction,
} from "discord.js";
import { commandMap } from "../commands/index.js";
import { fetchSongLyrics } from "../commands/lyrics.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
import { formatDuration } from "../utils/formatters.js";

export async function handleInteraction(interaction: Interaction) {
  // 1. Handle Slash Commands
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
    return;
  }

  // 2. Handle Autocomplete
  if (interaction.isAutocomplete()) {
    const cmd = commandMap.get(interaction.commandName);
    if (cmd && typeof cmd.autocomplete === "function") {
      try {
        await cmd.autocomplete(interaction);
      } catch (err: any) {
        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
        console.error(`[Autocomplete Error] /${interaction.commandName}:`, err);
      }
    }
    return;
  }

  // 3. Handle Button Clicks
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }

  // 4. Handle Select Menu (Dropdowns)
  if (interaction.isStringSelectMenu()) {
    await handleSelectMenuInteraction(interaction);
    return;
  }
}

async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  console.log(`[Interaction] Received /${interaction.commandName} from ${interaction.user.tag} (Channel: ${(interaction.channel as any)?.name || interaction.channelId})`);
  const cmd = commandMap.get(interaction.commandName);
  if (!cmd) {
    console.warn(`[Interaction] Command /${interaction.commandName} not found in commandMap`);
    return;
  }

  try {
    await cmd.execute(interaction);
  } catch (error: any) {
    console.error(`[Command Error] /${interaction.commandName}:`, error);
    const errMessage = "⚠️ An error occurred while executing this command!";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errMessage, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: errMessage, ephemeral: true }).catch(() => {});
    }
  }
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
  const player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    return interaction.reply({
      content: "❌ No active music session found.",
      ephemeral: true,
    });
  }

  // Voice Gate: strictly block anyone who is not in the same voice channel
  const gate = await validateVoiceGate(interaction, player);
  if (!gate.allowed) {
    return interaction.reply({
      content: gate.error!,
      ephemeral: true,
    });
  }

  // Acknowledge Discord immediately to eliminate the 3-second timeout ("didn't respond in time")
  if (interaction.customId === "player_queue" || interaction.customId === "player_lyrics") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
  } else {
    await interaction.deferUpdate().catch(() => {});
  }

  try {
    // If the player's node is currently disconnected, seamlessly failover to a healthy connected node
    if (!player.node || !player.node.connected) {
      const healthyNode = Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected);
      if (healthyNode) {
        console.log(`[Failover] Player's current node is disconnected. Migrating player to "${healthyNode.id}"...`);
        await player.changeNode(healthyNode, false).catch(() => {});
      }
    }

    switch (interaction.customId) {
      case "player_pause_resume": {
        console.log(`[Button: Pause/Resume] BEFORE: paused=${player.paused} | Song: "${player.queue.current?.info.title}" | Pos: ${player.position}ms`);
        if (player.paused) {
          await player.resume();
        } else {
          await player.pause();
        }
        console.log(`[Button: Pause/Resume] AFTER: paused=${player.paused} | Song: "${player.queue.current?.info.title}"`);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_rewind_10": {
        if (!player.queue.current) {
          await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => {});
          break;
        }
        const currentPos = player.position || 0;
        const newPos = Math.max(0, currentPos - 10000);
        await player.seek(newPos);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_forward_10": {
        if (!player.queue.current) {
          await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => {});
          break;
        }
        const currentPos = player.position || 0;
        const maxDuration = player.queue.current.info.duration || Infinity;
        const newPos = Math.min(maxDuration, currentPos + 10000);
        await player.seek(newPos);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_rewind_30": {
        if (!player.queue.current) {
          await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => {});
          break;
        }
        const currentPos = player.position || 0;
        const newPos = Math.max(0, currentPos - 30000);
        await player.seek(newPos);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_forward_30": {
        if (!player.queue.current) {
          await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => {});
          break;
        }
        const currentPos = player.position || 0;
        const maxDuration = player.queue.current.info.duration || Infinity;
        const newPos = Math.min(maxDuration, currentPos + 30000);
        await player.seek(newPos);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_skip": {
        try {
          if (player.queue.tracks.length > 0) {
            await player.skip();
          } else {
            await player.stopPlaying();
          }
        } catch {
          await player.stopPlaying().catch(() => {});
        }
        break;
      }

      case "player_prev": {
        if (player.queue.previous.length > 0) {
          const prev = player.queue.previous[0];
          await player.queue.add(prev, 0);
          await player.skip();
        } else {
          await interaction.followUp({
            content: "⚠️ No previous track in history.",
            ephemeral: true,
          }).catch(() => {});
        }
        break;
      }

      case "player_stop": {
        await player.filterManager.resetFilters().catch(() => {});
        player.setData("hifi_active", false);
        player.setData("filter_preset_key", "reset");
        player.setData("eq_preset", "Normal (Flat)");
        await player.destroy("Stopped by user via button");
        await interaction.editReply({
          content: `⏹️ Playback stopped by **${interaction.user.username}**. Equalizer reset to **Normal (Flat)**.`,
          embeds: [],
          components: [],
        }).catch(() => {});
        break;
      }

      case "player_loop": {
        const nextMode =
          player.repeatMode === "off"
            ? "track"
            : player.repeatMode === "track"
            ? "queue"
            : "off";

        await player.setRepeatMode(nextMode);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_shuffle": {
        if (player.queue.tracks.length < 2) {
          await interaction.followUp({
            content: "⚠️ Not enough tracks to shuffle.",
            ephemeral: true,
          }).catch(() => {});
          break;
        }
        await player.queue.shuffle();
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_voldown": {
        const newVol = Math.max(0, player.volume - 10);
        await player.setVolume(newVol);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_volup": {
        const newVol = Math.min(200, player.volume + 10);
        await player.setVolume(newVol);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_hifieq": {
        const isCurrentlyActive = Boolean(player.getData("hifi_active"));
        if (isCurrentlyActive) {
          player.setData("hifi_active", false);
          player.setData("filter_preset_key", "reset");
          player.setData("eq_preset", "Normal (Flat)");
          await player.filterManager.clearEQ();
          await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        } else {
          player.setData("hifi_active", true);
          player.setData("filter_preset_key", "hifi");
          player.setData("eq_preset", "💎 Hi-Fi Studio");
          await player.filterManager.setEQ(EQ_PRESETS.hifi);
          await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        }
        break;
      }

      case "player_queue": {
        const current = player.queue.current;
        const upcoming = player.queue.tracks;
        if (!current && upcoming.length === 0) {
          return interaction.editReply({ content: "⚠️ The queue is currently empty." });
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle("📋 Upcoming Queue")
          .setDescription(
            current
              ? `**Now Playing:**\n🎶 [${current.info.title}](${current.info.uri}) • \`[${formatDuration(current.info.duration || 0)}]\``
              : "No song currently playing."
          );

        if (upcoming.length > 0) {
          const list = upcoming.slice(0, 5).map((t, idx) => {
            const req = t.requester as any;
            const reqTag = req?.username ? ` • @${req.username}` : "";
            return `**${idx + 1}.** [${t.info.title}](${t.info.uri}) \`[${formatDuration(t.info.duration || 0)}]\`${reqTag}`;
          }).join("\n\n");

          const extra = upcoming.length > 5 ? `\n\n*...and ${upcoming.length - 5} more track(s)*` : "";
          embed.addFields([{ name: "Up Next", value: list + extra }]);
        } else {
          embed.addFields([{ name: "Up Next", value: "No more tracks in queue. Add more with `/play`!" }]);
        }

        return interaction.editReply({ embeds: [embed] });
      }

      case "player_lyrics": {
        const current = player.queue.current;
        if (!current) {
          return interaction.editReply({ content: "❌ No song is currently playing." });
        }

        const res = await fetchSongLyrics(current.info.title, current.info.author, player, current);
        if (!res.text) {
          return interaction.editReply({ content: `❌ No lyrics found for **${current.info.title}**.` });
        }

        let lyricsText = res.text;
        if (lyricsText.length > 4000) {
          lyricsText = lyricsText.substring(0, 3950) + "\n\n*(...lyrics truncated)*";
        }

        const embed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`📜 Lyrics: ${res.title.substring(0, 100)}`)
          .setDescription(lyricsText)
          .setFooter({ text: `Artist: ${res.artist || "Unknown"} | Powered by Studio Lyrics` });

        if (res.artworkUrl) embed.setThumbnail(res.artworkUrl);
        return interaction.editReply({ embeds: [embed] });
      }

      default:
        await interaction.followUp({ content: "Unknown button interaction.", ephemeral: true }).catch(() => {});
        break;
    }
  } catch (err: any) {
    if (err?.code === 10062 || err?.rawError?.code === 10062) {
      updateActivePlayerMessage(player, true).catch(() => {});
      return;
    }

    console.error("[Button Interaction Error]:", err);

    // If node was reconnecting or session dropped, gracefully failover
    if (err.message?.includes("Node Request") || err.message?.includes("not connected") || err.message?.includes("Socket")) {
      const healthyNode = Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && n.id !== player.node.id);
      if (healthyNode) {
        await player.changeNode(healthyNode, false).catch(() => {});
      }
      await interaction.followUp({
        content: "🔄 Audio connection refreshed. Please press the button again!",
        ephemeral: true,
      }).catch(() => {});
      return;
    }

    await interaction.followUp({ content: "⚠️ Action could not be completed. Please try again.", ephemeral: true }).catch(() => {});
  }
}

async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction) {
  const player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    return interaction.reply({ content: "❌ No active music session found.", ephemeral: true });
  }

  const gate = await validateVoiceGate(interaction, player);
  if (!gate.allowed) {
    return interaction.reply({ content: gate.error!, ephemeral: true });
  }

  // Acknowledge Discord immediately
  await interaction.deferUpdate().catch(() => {});

  try {
    if (!player.node || !player.node.connected) {
      const healthyNode = Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected);
      if (healthyNode) {
        await player.changeNode(healthyNode, false).catch(() => {});
      }
    }

    if (interaction.customId === "player_filter_menu") {
      const preset = interaction.values[0];
      await player.filterManager.resetFilters();
      await player.filterManager.clearEQ();
      player.setData("filter_preset_key", preset);

      let presetLabel = "Normal (Flat)";

      switch (preset) {
        case "hifi":
          player.setData("hifi_active", true);
          player.setData("eq_preset", "💎 Hi-Fi Studio");
          await player.filterManager.setEQ(EQ_PRESETS.hifi);
          presetLabel = "💎 Hi-Fi Studio";
          break;

        case "bassboost":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🔊 Bass Boost");
          await player.filterManager.setEQ(EQ_PRESETS.bassboost);
          presetLabel = "🔊 Bass Boost";
          break;

        case "turbo":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🏎️ Turbo Rush");
          await player.filterManager.setSpeed(1.35);
          presetLabel = "🏎️ Turbo Rush (1.35x)";
          break;

        case "treble":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎤 Treble Boost");
          await player.filterManager.setEQ(EQ_PRESETS.treble);
          presetLabel = "🎤 Treble Boost";
          break;

        case "8d":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎧 8D Audio");
          await player.filterManager.toggleRotation(0.35);
          presetLabel = "🎧 8D Audio";
          break;

        case "nightcore":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "⚡ Nightcore");
          await player.filterManager.toggleNightcore();
          presetLabel = "⚡ Nightcore";
          break;

        case "vaporwave":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🌊 Vaporwave");
          await player.filterManager.toggleVaporwave();
          presetLabel = "🌊 Vaporwave";
          break;

        case "karaoke":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎤 Karaoke");
          await player.filterManager.toggleKaraoke(1, 1, 220, 100);
          presetLabel = "🎤 Karaoke (Sing-Along)";
          break;

        case "reset":
        default:
          player.setData("hifi_active", false);
          player.setData("eq_preset", "Normal (Flat)");
          presetLabel = "🔄 Normal (Flat Pure Audio)";
          break;
      }

      await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
    }
  } catch (err: any) {
    if (err?.code === 10062 || err?.rawError?.code === 10062) {
      updateActivePlayerMessage(player, true).catch(() => {});
      return;
    }
    console.error("[SelectMenu Interaction Error]:", err);
    await interaction.followUp({ content: "⚠️ Filter could not be applied. Please try again.", ephemeral: true }).catch(() => {});
  }
}
