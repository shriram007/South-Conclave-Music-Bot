import { canSeek, parseSeek, seekToken } from "../utils/playback.js";
import { purgeAutoplayTracks } from "../lavalink/client.js";
import {
  ActionRowBuilder,
  ButtonInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Interaction,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { commandMap } from "../commands/index.js";
import { fetchSongLyrics } from "../commands/lyrics.js";
import {
  clearAllFilters,
  getBestNode,
  isNodeHealthy,
  lavalink,
  markNodeDegraded,
  smoothFadePause,
  smoothFadeResume,
  updateActivePlayerMessage,
  validateVoiceGate,
} from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";
import { buildQueueMessage } from "../lavalink/queueUI.js";
import { autoDeleteMessage } from "../utils/cleanup.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
import { toggleFavorite } from "../utils/favorites.js";
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

  // 5. Handle Modal Submissions
  if (interaction.isModalSubmit()) {
    await handleModalSubmitInteraction(interaction);
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
    if (error?.code === 10062 || error?.rawError?.code === 10062) {
      console.warn(`[Command Warn] /${interaction.commandName}: Interaction expired before reply (code 10062).`);
      return;
    }
    console.error(`[Command Error] /${interaction.commandName}:`, error);
    const errMessage = "⚠️ An error occurred while executing this command!";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: errMessage, flags: MessageFlags.Ephemeral }).catch(() => { });
    } else {
      await interaction.reply({ content: errMessage, flags: MessageFlags.Ephemeral }).catch(() => { });
    }
  }
}

async function handleButtonInteraction(interaction: ButtonInteraction) {
  const [action, controlToken, direction] = interaction.customId.split(":");
  const player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    return interaction.reply({
      content: "❌ No active music session found.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const seekAction = action === "player_seek" || action === "player_seek_step";
  if (seekAction && (!canSeek(player.queue.current) || controlToken !== seekToken(player))) {
    return interaction.reply({ content: "This seek control has expired or this stream cannot be seeked. Use the current player card.", flags: MessageFlags.Ephemeral });
  }
  // Voice Gate: strictly block anyone who is not in the same voice channel (allow passive inspection)
  const isPassiveInspection =
    interaction.customId === "player_queue" ||
    interaction.customId === "player_lyrics" ||
    interaction.customId === "qm_close" ||
    interaction.customId.startsWith("qm_prev") ||
    interaction.customId.startsWith("qm_next");

  if (!isPassiveInspection) {
    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({
        content: gate.error!,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Acknowledge Discord immediately to eliminate the 3-second timeout ("didn't respond in time")
  if (interaction.customId === "player_queue" || interaction.customId === "player_lyrics") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
  } else if (action === "player_seek") {
    // showModal requires an un-deferred raw interaction
  } else {
    await interaction.deferUpdate().catch(() => { });
  }

  try {
    // Proactive Failover: If the player's node is disconnected or degraded, migrate to best healthy node before sending command
    if (action !== "player_seek" && (!player.node || !player.node.connected || !isNodeHealthy(player.node.id))) {
      const bestId = getBestNode();
      const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
      if (healthyNode && healthyNode.id !== player.node?.id) {
        console.log(`[Failover] Player's current node (${player.node?.id || "none"}) is disconnected or degraded. Migrating to "${healthyNode.id}"...`);
        await player.changeNode(healthyNode, false).catch(() => { });
      }
    }

    // Interactive Queue Manager Actions (qm_<action>_<page>_<selected>)
    if (interaction.customId.startsWith("qm_")) {
      if (interaction.customId === "qm_close") {
        await interaction.deleteReply().catch(async () => {
          await interaction.editReply({ content: "🗑️ Queue closed.", embeds: [], components: [] }).catch(() => {});
        });
        return;
      }

      const parts = interaction.customId.split("_");
      const action = parts[1];
      const page = parseInt(parts[2], 10) || 0;
      const selected = parseInt(parts[3], 10) || 0;
      const targetIdx = page * 5 + selected;

      switch (action) {
        case "prev": {
          const newPage = Math.max(0, page - 1);
          const queueMsg = buildQueueMessage(player, newPage, 0, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "next": {
          const newPage = page + 1;
          const queueMsg = buildQueueMessage(player, newPage, 0, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "remove": {
          if (targetIdx >= 0 && targetIdx < player.queue.tracks.length) {
            player.queue.tracks.splice(targetIdx, 1);
            await updateActivePlayerMessage(player, true);
          }
          const maxTracksOnPage = Math.max(0, player.queue.tracks.length - page * 5);
          const newSelected = Math.min(selected, Math.max(0, maxTracksOnPage - 1));
          const queueMsg = buildQueueMessage(player, page, newSelected, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "moveup": {
          let newPage = page;
          let newSelected = selected;
          if (targetIdx > 0 && targetIdx < player.queue.tracks.length) {
            const [track] = player.queue.tracks.splice(targetIdx, 1);
            player.queue.tracks.splice(targetIdx - 1, 0, track);
            newSelected = selected - 1;
            if (newSelected < 0 && newPage > 0) {
              newPage--;
              newSelected = 4;
            }
            await updateActivePlayerMessage(player, true);
          }
          const queueMsg = buildQueueMessage(player, newPage, newSelected, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "movedown": {
          let newPage = page;
          let newSelected = selected;
          if (targetIdx >= 0 && targetIdx < player.queue.tracks.length - 1) {
            const [track] = player.queue.tracks.splice(targetIdx, 1);
            player.queue.tracks.splice(targetIdx + 1, 0, track);
            newSelected = selected + 1;
            if (newSelected >= 5) {
              newPage++;
              newSelected = 0;
            }
            await updateActivePlayerMessage(player, true);
          }
          const queueMsg = buildQueueMessage(player, newPage, newSelected, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "top": {
          if (targetIdx > 0 && targetIdx < player.queue.tracks.length) {
            const [track] = player.queue.tracks.splice(targetIdx, 1);
            player.queue.tracks.unshift(track);
            await updateActivePlayerMessage(player, true);
          }
          const queueMsg = buildQueueMessage(player, 0, 0, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }

        case "play": {
          if (targetIdx >= 0 && targetIdx < player.queue.tracks.length) {
            const [track] = player.queue.tracks.splice(targetIdx, 1);
            player.queue.tracks.unshift(track);
            await player.skip();
            await updateActivePlayerMessage(player, true);
          }
          const queueMsg = buildQueueMessage(player, 0, 0, interaction.user.username);
          await interaction.editReply(queueMsg).catch(() => {});
          return;
        }
      }
    }

    if (seekAction && (controlToken !== seekToken(player) || !canSeek(player.queue.current))) {
      const notice = { content: "The song changed. Use the current player card.", flags: MessageFlags.Ephemeral as const };
      if (interaction.deferred) await interaction.followUp(notice);
      else await interaction.reply(notice);
      return;
    }
    switch (action) {
      case "player_seek_step": {
        const target = parseSeek(direction === "back" ? "-15" : "+15", player.position || 0, player.queue.current!.info.duration)!;
        await player.seek(target);
        await updateActivePlayerMessage(player, true);
        return;
      }
      case "player_pause_resume": {
        console.log(`[Button: Pause/Resume] BEFORE: paused=${player.paused} | Song: "${player.queue.current?.info.title}" | Pos: ${player.position}ms`);
        if (player.paused) {
          await smoothFadeResume(player);
        } else {
          await smoothFadePause(player);
        }
        console.log(`[Button: Pause/Resume] AFTER: paused=${player.paused} | Song: "${player.queue.current?.info.title}"`);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_seek": {
        if (!player.queue.current) {
          return interaction.reply({ content: "⚠️ No track currently playing.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        const currentPos = player.position || 0;
        const duration = player.queue.current.info.duration || 0;
        const modal = new ModalBuilder()
          .setCustomId(`modal_player_seek:${seekToken(player)}`)
          .setTitle("⏩ Jump to Track Timestamp");

        const input = new TextInputBuilder()
          .setCustomId("seek_target")
          .setLabel(`Position (${formatDuration(currentPos)} / ${formatDuration(duration)})`)
          .setPlaceholder("e.g. 1:30, 90, +30, or -15")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(12);

        const modalRow = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
        modal.addComponents(modalRow);

        await interaction.showModal(modal);
        return;
      }

      case "player_rewind_10": {
        if (!player.queue.current) {
          await interaction.followUp({ content: "⚠️ No track currently playing.", flags: MessageFlags.Ephemeral }).catch(() => { });
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
          await interaction.followUp({ content: "⚠️ No track currently playing.", flags: MessageFlags.Ephemeral }).catch(() => { });
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
          await interaction.followUp({ content: "⚠️ No track currently playing.", flags: MessageFlags.Ephemeral }).catch(() => { });
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
          await interaction.followUp({ content: "⚠️ No track currently playing.", flags: MessageFlags.Ephemeral }).catch(() => { });
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
          if (interaction.channel && "send" in interaction.channel) {
            const notice = await (interaction.channel as any).send({
              content: `⏭️ **${interaction.user.username}** skipped the track.`,
            }).catch(() => null);
            if (notice) autoDeleteMessage(notice, 5000);
          }
        } catch {
          await player.stopPlaying().catch(() => { });
        }
        break;
      }

      case "player_prev": {
        if (player.queue.previous.length > 0) {
          const prev = player.queue.previous[0];
          await player.queue.add(prev, 0);
          await player.skip();
          if (interaction.channel && "send" in interaction.channel) {
            const notice = await (interaction.channel as any).send({
              content: `⏮️ **${interaction.user.username}** replayed previous track.`,
            }).catch(() => null);
            if (notice) autoDeleteMessage(notice, 5000);
          }
        } else {
          await interaction.followUp({
            content: "⚠️ No previous track in history.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => { });
        }
        break;
      }

      case "player_stop": {
        await player.filterManager.resetFilters().catch(() => { });
        player.setData("hifi_active", false);
        player.setData("filter_preset_key", "reset");
        player.setData("eq_preset", "Normal (Flat)");
        await player.destroy("Stopped by user via button");
        await interaction.editReply({
          content: `⏹️ Playback stopped by **${interaction.user.username}**. Equalizer reset to **Normal (Flat)**.`,
          embeds: [],
          components: [],
        }).catch(() => { });
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

        const loopNotice =
          nextMode === "track"
            ? "🔂 Looping **current track**."
            : nextMode === "queue"
              ? "🔁 Looping **entire queue**."
              : "➡️ Loop **disabled**.";

        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `${loopNotice} (by **${interaction.user.username}**)`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 5000);
        }
        break;
      }

      case "player_shuffle": {
        if (player.queue.tracks.length < 2) {
          await interaction.followUp({
            content: "⚠️ Not enough tracks to shuffle.",
            flags: MessageFlags.Ephemeral,
          }).catch(() => { });
          break;
        }
        await player.queue.shuffle();
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));

        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `🔀 Queue shuffled by **${interaction.user.username}** (${player.queue.tracks.length} tracks).`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 5000);
        }
        break;
      }

      case "player_voldown": {
        const newVol = Math.max(0, player.volume - 10);
        await player.setVolume(newVol);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_volup": {
        const newVol = Math.min(100, player.volume + 10);
        await player.setVolume(newVol);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        break;
      }

      case "player_hifieq": {
        const isCurrentlyActive = Boolean(player.getData("hifi_active"));
        let hifiNoticeText = "";
        if (isCurrentlyActive) {
          await clearAllFilters(player);
          await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
          hifiNoticeText = "🔄 Equalizer reset to **Normal (Flat)** (no EQ or effects).";
        } else {
          await clearAllFilters(player);
          player.setData("hifi_active", true);
          player.setData("filter_preset_key", "hifi");
          player.setData("eq_preset", "💎 Hi-Fi Studio");
          await player.filterManager.setEQ(EQ_PRESETS.hifi);
          await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
          hifiNoticeText = "💎 **Hi-Fi Studio Preset Activated!** (Audiophile dynamics & crisp highs)";
        }

        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `${hifiNoticeText} (by **${interaction.user.username}**)`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 5000);
        }
        break;
      }

      case "player_queue": {
        const queueMsg = buildQueueMessage(player, 0, 0, interaction.user.username);
        return interaction.editReply(queueMsg);
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

      case "player_like": {
        const current = player.queue.current;
        if (!current) {
          await interaction.followUp({ content: "⚠️ No song is currently playing to like!", flags: MessageFlags.Ephemeral }).catch(() => {});
          break;
        }

        const res = toggleFavorite(interaction.user.id, {
          title: current.info.title,
          uri: current.info.uri || "",
          author: (current.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim(),
          duration: current.info.duration || 0,
          artworkUrl: current.info.artworkUrl || undefined,
        });

        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));

        const noticeContent = res.added
          ? `❤️ Added **[${current.info.title}](${current.info.uri})** to your favorites! (${res.total} total) • Use \`/favorites play\` anytime.`
          : `💔 Removed **[${current.info.title}](${current.info.uri})** from your favorites.`;

        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `${noticeContent} (by **${interaction.user.username}**)`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 6000);
        }
        break;
      }

      case "player_autoplay": {
        const currentAutoplay = Boolean(player.getData("autoplay") ?? true);
        const newAutoplay = !currentAutoplay;
        player.setData("autoplay", newAutoplay);
    if (!newAutoplay) purgeAutoplayTracks(player);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));

        const noticeText = newAutoplay
          ? "📻 **Smart Autoplay ON:** Infinite Spotify Radio mode will continue when queue ends."
          : "⏸️ **Smart Autoplay OFF:** Playback will stop when queue ends.";

        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `${noticeText} (by **${interaction.user.username}**)`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 6000);
        }
        break;
      }

      default:
        await interaction.followUp({ content: "Unknown button interaction.", flags: MessageFlags.Ephemeral }).catch(() => { });
        break;
    }
  } catch (err: any) {
    if (err?.code === 10062 || err?.rawError?.code === 10062) {
      updateActivePlayerMessage(player, true).catch(() => { });
      return;
    }

    console.error("[Button Interaction Error]:", err?.message || err);

    // If node was reconnecting, timed out, or session dropped, gracefully failover and mark degraded
    if (
      err.message?.includes("Node Request") ||
      err.message?.includes("not connected") ||
      err.message?.includes("Socket") ||
      err.message?.includes("fetch failed") ||
      err.message?.includes("aborted due to timeout") ||
      err.name === "AbortError" ||
      err.name === "ConnectTimeoutError" ||
      err.cause?.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      if (player?.node) markNodeDegraded(player.node.id);
      const bestId = getBestNode();
      const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
      if (healthyNode && healthyNode.id !== player.node?.id) {
        console.log(`[Failover] Migrating player after button error from ${player.node?.id || "none"} to "${healthyNode.id}"...`);
        await player.changeNode(healthyNode, false).catch(() => { });
      }
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({
          content: "🔄 Audio connection refreshed. Please press the button again!",
          flags: MessageFlags.Ephemeral,
        }).catch(() => { });
      }
      return;
    }

    await interaction.followUp({ content: "⚠️ Action could not be completed. Please try again.", flags: MessageFlags.Ephemeral }).catch(() => { });
  }
}

async function handleSelectMenuInteraction(interaction: StringSelectMenuInteraction) {
  const player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    return interaction.reply({ content: "❌ No active music session found.", flags: MessageFlags.Ephemeral });
  }

  if (!interaction.customId.startsWith("qm_select")) {
    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({ content: gate.error!, flags: MessageFlags.Ephemeral });
    }
  }

  // Acknowledge Discord immediately
  await interaction.deferUpdate().catch(() => { });

  try {
    if (!player.node || !player.node.connected || !isNodeHealthy(player.node.id)) {
      const bestId = getBestNode();
      const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
      if (healthyNode && healthyNode.id !== player.node?.id) {
        await player.changeNode(healthyNode, false).catch(() => { });
      }
    }

    if (interaction.customId.startsWith("player_timeline:")) {
      const token = interaction.customId.split(":")[1];
      const target = Number(interaction.values[0]);
      if (!canSeek(player.queue.current) || token !== seekToken(player) || !Number.isFinite(target) || target < 0 || target >= player.queue.current!.info.duration) {
        await interaction.followUp({ content: "That timeline has expired. Use the current player card.", flags: MessageFlags.Ephemeral });
        return;
      }
      await player.seek(Math.min(target, player.queue.current!.info.duration - 1000));
      await updateActivePlayerMessage(player, true);
      return;
    }

    // Queue Manager: Switch selected track on current page
    if (interaction.customId.startsWith("qm_select_")) {
      const page = parseInt(interaction.customId.split("_")[2], 10) || 0;
      const selectedIndex = parseInt(interaction.values[0], 10) || 0;
      const queueMsg = buildQueueMessage(player, page, selectedIndex, interaction.user.username);
      await interaction.editReply(queueMsg).catch(() => {});
      return;
    }

    if (interaction.customId === "player_filter_menu") {
      const preset = interaction.values[0];

      if (preset === "reset") {
        await clearAllFilters(player);
        await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
        if (interaction.channel && "send" in interaction.channel) {
          const notice = await (interaction.channel as any).send({
            content: `🔄 Equalizer reset to **Normal (Flat)** (by **${interaction.user.username}**).`,
          }).catch(() => null);
          if (notice) autoDeleteMessage(notice, 5000);
        }
        return;
      }

      await clearAllFilters(player);
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

      if (interaction.channel && "send" in interaction.channel) {
        const notice = await (interaction.channel as any).send({
          content: `🎛️ **${interaction.user.username}** applied sound filter: **${presetLabel}**`,
        }).catch(() => null);
        if (notice) autoDeleteMessage(notice, 5000);
      }
    }
  } catch (err: any) {
    if (err?.code === 10062 || err?.rawError?.code === 10062) {
      updateActivePlayerMessage(player, true).catch(() => { });
      return;
    }
    console.error("[SelectMenu Interaction Error]:", err);
    await interaction.followUp({ content: "⚠️ The player action could not be completed. Please try again.", flags: MessageFlags.Ephemeral }).catch(() => { });
  }
}

async function handleModalSubmitInteraction(interaction: ModalSubmitInteraction) {
  if (interaction.customId.startsWith("modal_player_seek")) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || !player.queue.current) {
      return interaction.reply({ content: "❌ Nothing is currently playing.", flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({ content: gate.error!, flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

    if (!canSeek(player.queue.current) || interaction.customId.split(":")[1] !== seekToken(player)) {
      await interaction.editReply({ content: "The song changed or cannot be seeked. Open Seek again from the current player card." });
      return;
    }
    const duration = player.queue.current.info.duration;
    const targetMs = parseSeek(interaction.fields.getTextInputValue("seek_target"), player.position || 0, duration);
    if (targetMs === null) {
      await interaction.editReply({ content: "Use a timestamp such as 1:30, 90, +30, or -15." });
      return;
    }

    await player.seek(targetMs);
    await updateActivePlayerMessage(player, true);

    await interaction.editReply({
      content: `⏩ Jumped to **${formatDuration(targetMs)}** (\`${formatDuration(targetMs)} / ${formatDuration(duration)}\`)`,
    });

    if (interaction.channel && "send" in interaction.channel) {
      const notice = await (interaction.channel as any).send({
        content: `⏩ **${interaction.user.username}** jumped to \`${formatDuration(targetMs)}\``,
      }).catch(() => null);
      if (notice) autoDeleteMessage(notice, 5000);
    }
  }
}
