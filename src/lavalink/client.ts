import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  StringSelectMenuInteraction,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import { LavalinkManager, Player, Track } from "lavalink-client";
import { config } from "../config.js";
import { buildPlayerMessage } from "./playerUI.js";
import { autoDeleteMessage } from "../utils/cleanup.js";
import { getChannelBitrateInfo, isRelevantTrack } from "../utils/formatters.js";
import { is247Enabled } from "../utils/twentyFourSeven.js";

export let lavalink: LavalinkManager;
export let discordClient: Client;

// Track active player messages so we can update or clean them up
export const activePlayerMessages = new Map<string, string>(); // guildId -> messageId

// Global cache of stream-restricted / login-required video IDs so we never re-select or loop on them
export const restrictedTrackIds = new Set<string>();

export function initLavalink(client: Client) {
  discordClient = client;
  lavalink = new LavalinkManager({
    nodes: [
      {
        authorization: "https://discord.gg/mjS5J2K3ep",
        host: "lava-v4.millohost.my.id",
        port: 443,
        secure: true,
        id: "Millo-SingaporeNode",
      },
      {
        authorization: "https://seretia.link/discord",
        host: "lavalinkv4.serenetia.com",
        port: 443,
        secure: true,
        id: "Serenetia-HighSpeed",
      },
      {
        authorization: "free",
        host: "lavalink-v4.triniumhost.com",
        port: 443,
        secure: true,
        id: "Trinium-FastNode",
      },
    ],
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard.send(payload);
    },
    autoSkip: true,
    autoMove: true,
    playerOptions: {
      clientBasedPositionUpdateInterval: 150, // 150ms position accuracy for ultra-smooth timestamps
      defaultSearchPlatform: "ytmsearch", // YouTube Music HQ 256k as default
      volumeDecrementer: 1,
      onDisconnect: {
        autoReconnect: true,
        destroyPlayer: false,
      },
    },
  });

  // Lavalink Node Events
  lavalink.nodeManager.on("connect", (node) => {
    console.log(`[Lavalink] Connected to audio node "${node.id}" (${node.options.host}:${node.options.port})`);
  });

  lavalink.nodeManager.on("disconnect", (node, reason) => {
    console.warn(`[Lavalink] Disconnected from audio node "${node.id}": ${reason?.reason || "Unknown reason"}`);
  });

  lavalink.nodeManager.on("error", (node, error) => {
    console.error(`[Lavalink] Node "${node.id}" encountered an error:`, error.message);
  });

  // Dedicated Live Player Ticker (smooth 3.5s updates while playing)
  const liveTickers = new Map<string, NodeJS.Timeout>();

  function startLivePlayerTicker(player: Player) {
    stopLivePlayerTicker(player.guildId);
    const ticker = setInterval(async () => {
      try {
        if (!player.connected || !player.queue.current) {
          stopLivePlayerTicker(player.guildId);
          return;
        }
        if (player.paused) return;
        await updateActivePlayerMessage(player);
      } catch {}
    }, 3500);
    liveTickers.set(player.guildId, ticker);
  }

  function stopLivePlayerTicker(guildId: string) {
    const ticker = liveTickers.get(guildId);
    if (ticker) {
      clearInterval(ticker);
      liveTickers.delete(guildId);
    }
  }

  // Player Events
  lavalink.on("trackStart", async (player: Player, track: Track | null) => {
    if (!player.textChannelId || !track) return;
    const channel = (client.channels.cache.get(player.textChannelId) ||
      await client.channels.fetch(player.textChannelId).catch(() => null)) as TextChannel | null;
    if (!channel || !channel.isTextBased()) return;

    try {
      const prevMessageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);
      const playerMsgOptions = buildPlayerMessage(player, track);

      // Clean up previous Now Playing card so the new song gets a fresh announcement card at the bottom
      if (prevMessageId) {
        try {
          const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
          if (prevMsg) {
            await prevMsg.delete().catch(() => {});
          }
        } catch {}
      }

      // Always send a fresh, prominent Now Playing card at the bottom of the chat for new songs
      const sentMsg = await channel.send(playerMsgOptions);
      activePlayerMessages.set(player.guildId, sentMsg.id);
      player.setData("active_message_id", sentMsg.id);

      // Start live progress bar updates
      startLivePlayerTicker(player);

      // Check voice channel bitrate quality and warn if low
      if (player.voiceChannelId) {
        const voiceChan = channel.guild.channels.cache.get(player.voiceChannelId) as VoiceBasedChannel | undefined;
        if (voiceChan && voiceChan.isVoiceBased()) {
          const bitrateInfo = getChannelBitrateInfo(voiceChan);
          if (!bitrateInfo.isMaxQuality) {
            channel.send({
              content: bitrateInfo.recommendation,
            }).then((msg) => autoDeleteMessage(msg, 12000)).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error("[Lavalink] Failed to send trackStart message:", err);
    }
  });

  lavalink.on("queueEnd", async (player: Player) => {
    stopLivePlayerTicker(player.guildId);
    if (!player.textChannelId) return;
    const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
    if (channel) {
      const is247 = is247Enabled(player.guildId);
      const prevMessageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);

      const queueFinishedEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("🎶 Queue Finished")
        .setDescription(
          is247
            ? "✨ All tracks finished playing. Staying **24/7** in voice channel!\n\nUse `/play <song>` to queue more music."
            : "✨ All tracks finished playing. Use `/play <song>` to start jamming again!"
        )
        .setFooter({ text: "💎 South Conclave Audiophile Engine" })
        .setTimestamp();

      if (prevMessageId) {
        try {
          const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
          if (prevMsg) {
            await prevMsg.edit({ embeds: [queueFinishedEmbed], components: [] });
          } else {
            await channel.send({ embeds: [queueFinishedEmbed] });
          }
        } catch {
          await channel.send({ embeds: [queueFinishedEmbed] }).catch(() => null);
        }
      } else {
        await channel.send({ embeds: [queueFinishedEmbed] }).catch(() => null);
      }

      activePlayerMessages.delete(player.guildId);
      player.setData("active_message_id", null);
    }
  });

  lavalink.on("trackEnd", (player: Player, track, payload) => {
    console.log(`[Player] trackEnd: "${track?.info.title}" | Reason: ${payload.reason} | Position: ${player.position}ms`);
    if (!player.queue.current) {
      stopLivePlayerTicker(player.guildId);
    }
  });

  lavalink.on("playerDestroy", (player: Player) => {
    stopLivePlayerTicker(player.guildId);
    activePlayerMessages.delete(player.guildId);
  });

  lavalink.on("trackError", async (player: Player, track, payload) => {
    const errorMsg = payload?.exception?.message || JSON.stringify(payload);
    console.error(`[Lavalink] Error playing "${track?.info.title}":`, errorMsg);

    if (!track) return;

    // Cache the failed track ID so neither recovery nor future searches pick it again
    if (track.info.identifier) {
      restrictedTrackIds.add(track.info.identifier);
    }

    // If single track loop is active, disable it to prevent an infinite error loop on this failing song
    if (player.repeatMode === "track") {
      console.warn(`[Universal Recovery] Disabling track loop because "${track?.info.title}" failed to stream.`);
      await player.setRepeatMode("off").catch(() => {});
    }

    const failedId = track.info.identifier;
    const rawTitle = track.info.title || "";
    const recoveryAttempts = ((player.getData("recovery_attempts") as number) || 0) + 1;
    player.setData("recovery_attempts", recoveryAttempts);

    // Circuit breaker: prevent infinite retry loops if all sources fail
    if (recoveryAttempts > 2) {
      console.warn(`[Universal Recovery] Max recovery attempts (2) reached for "${rawTitle}". Skipping track.`);
      player.setData("recovery_attempts", 0);
      player.setData("recovering_track", false);

      if (player.textChannelId) {
        const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
        channel?.send(`⚠️ **Stream Restricted by YouTube:** All video streams for **${rawTitle}** require Google login. Skipping to next song in queue.`).catch(() => {});
      }
      await player.skip().catch(() => {});
      return;
    }

    // Universal Auto-Recovery for blocked/age-gated/login-required/broken streams
    if (!player.getData("recovering_track")) {
      try {
        player.setData("recovering_track", true);

        const cleanTitle = rawTitle
          .replace(/\|.*/, "")
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/video song/gi, "")
          .replace(/official video/gi, "")
          .replace(/full video/gi, "")
          .replace(/lyric video/gi, "")
          .replace(/4k/gi, "")
          .replace(/hd/gi, "")
          .trim();

        const cleanAuthor = (track.info.author || "").replace(/- Topic/gi, "").trim();
        const fallbackQuery = `${cleanTitle} ${cleanAuthor}`.trim();

        console.log(`[Universal Recovery] Stream restricted for "${rawTitle}" (ID: ${failedId}). Attempt #${recoveryAttempts} auto-recovering as "${fallbackQuery}"...`);

        // Check alternate connected nodes first if the current node had the playback failure
        const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
        const alternateNodes = connectedNodes.filter((n) => n.id !== player.node.id);
        const nodesToTry = [...alternateNodes, player.node];

        let recoveredTrack: Track | null = null;
        let targetNode = player.node;

        for (const node of nodesToTry) {
          try {
            // Strategy 1: YouTube Music / YouTube Audio - Authentic studio track, excluding failed ID & checking title relevance
            let ytRes = await node.search({ query: `${cleanTitle} audio`, source: "ytmsearch" }, track.requester);
            if (!ytRes?.tracks?.length || ytRes.loadType === "empty" || ytRes.loadType === "error") {
              ytRes = await node.search({ query: `${cleanTitle} lyrical`, source: "ytsearch" }, track.requester);
            }
            if (ytRes?.tracks?.length) {
              const ytCandidate = ytRes.tracks.find(
                (t) => t.info.identifier !== failedId &&
                       !restrictedTrackIds.has(t.info.identifier) &&
                       isRelevantTrack(t.info.title, cleanTitle)
              );
              if (ytCandidate) {
                recoveredTrack = ytCandidate;
                targetNode = node;
                console.log(`[Universal Recovery] Found authentic alternative YouTube audio on node "${node.id}": "${ytCandidate.info.title}"`);
                break;
              }
            }

            // Strategy 2: SoundCloud (scsearch) with STRICT title matching (never accept unrelated DJ sets)
            const scRes = await node.search({ query: fallbackQuery, source: "scsearch" }, track.requester);
            if (scRes?.tracks?.length && scRes.loadType !== "empty" && scRes.loadType !== "error") {
              const scCandidate = scRes.tracks.find(
                (t) => t.info.identifier !== failedId &&
                       !restrictedTrackIds.has(t.info.identifier) &&
                       isRelevantTrack(t.info.title, cleanTitle)
              );
              if (scCandidate) {
                recoveredTrack = scCandidate;
                targetNode = node;
                console.log(`[Universal Recovery] Found verified SoundCloud alternative on node "${node.id}": "${scCandidate.info.title}"`);
                break;
              }
            }
          } catch (e: any) {
            console.warn(`[Universal Recovery] Search failed on node ${node.id}:`, e?.message);
          }
        }

        if (recoveredTrack) {
          // If the recovery track was found on another node, migrate player
          if (player.node.id !== targetNode.id) {
            console.log(`[Universal Recovery] Migrating player from ${player.node.id} to ${targetNode.id}...`);
            await player.changeNode(targetNode, false).catch((err) => {
              console.warn("[Universal Recovery] changeNode error:", err);
            });
          }

          recoveredTrack.requester = track.requester;
          await player.play({ clientTrack: recoveredTrack, noReplace: false });

          if (player.textChannelId) {
            const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
            channel?.send(`🔄 **Auto-Recovered:** Login restriction detected on video. Swapped to high-fidelity stream: **[${recoveredTrack.info.title}](${recoveredTrack.info.uri})**`).catch(() => {});
          }

          setTimeout(() => {
            player.setData("recovering_track", false);
            player.setData("recovery_attempts", 0);
          }, 6000);
          return;
        }
      } catch (err) {
        console.error("[Universal Recovery Failed]:", err);
      } finally {
        player.setData("recovering_track", false);
      }
    }

    if (!player.textChannelId) return;
    const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
    if (channel) {
      channel.send(`⚠️ Error playing **${track?.info.title || "track"}**: ${payload.exception?.message || "Audio stream error"}`).catch(() => {});
    }
  });

  return lavalink;
}

/**
 * Validates member voice state and gets or creates player
 */
export async function getOrCreatePlayer(interaction: ChatInputCommandInteraction): Promise<{
  player: Player | null;
  error?: string;
}> {
  const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
  if (!guild) {
    return {
      player: null,
      error: "❌ **The bot is not in this server!**\nIt looks like it was installed to your account as a user app instead of being added to the server.\n👉 Please add the bot directly to your server using the bot invite link so it can join voice channels.",
    };
  }

  // Safely resolve guild member to guarantee voice state
  const member = guild.members.cache.get(interaction.user.id) || await guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return { player: null, error: "❌ You must be connected to a voice channel first!" };
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (botMember?.voice?.channelId && botMember.voice.channelId !== voiceChannel.id) {
    return {
      player: null,
      error: `❌ You must be in the same voice channel as me (<#${botMember.voice.channelId}>)!`,
    };
  }

  const permissions = voiceChannel.permissionsFor(interaction.client.user);
  if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
    return {
      player: null,
      error: "❌ I need **Connect** and **Speak** permissions in your voice channel!",
    };
  }

  let player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    console.log(`[Player] Creating player for guild ${interaction.guildId} in voice channel ${voiceChannel.name} (${voiceChannel.id})`);
    player = lavalink.createPlayer({
      guildId: interaction.guildId!,
      voiceChannelId: voiceChannel.id,
      textChannelId: interaction.channelId,
      selfDeaf: true,
      selfMute: false,
      volume: 100,
    });
    player.setData("hifi_active", false);
    player.setData("eq_preset", "Normal (Flat)");
  }

  if (!player.connected) {
    console.log(`[Player] Connecting to voice channel ${voiceChannel.name}...`);
    await player.connect();
    console.log(`[Player] Connected to voice channel ${voiceChannel.name}!`);
  }

  return { player };
}

interface MessageUpdaterState {
  inFlight: boolean;
  pending: boolean;
  lastEditTime: number;
  timer?: NodeJS.Timeout;
}

const updaterStates = new Map<string, MessageUpdaterState>();

/**
 * Updates the active Now Playing message in the text channel with rate-limiting & queuing protection
 */
export async function updateActivePlayerMessage(player: Player, immediate: boolean = false): Promise<void> {
  if (!player.textChannelId) return;

  let state = updaterStates.get(player.guildId);
  if (!state) {
    state = { inFlight: false, pending: false, lastEditTime: 0 };
    updaterStates.set(player.guildId, state);
  }

  const now = Date.now();
  const MIN_INTERVAL = 2200; // minimum 2.2s between message edits to guarantee zero Discord 429 rate limits
  const elapsed = now - state.lastEditTime;

  if (state.inFlight) {
    state.pending = true;
    return;
  }

  if (!immediate && elapsed < MIN_INTERVAL) {
    state.pending = true;
    if (!state.timer) {
      state.timer = setTimeout(async () => {
        state!.timer = undefined;
        if (state!.pending) {
          state!.pending = false;
          await updateActivePlayerMessage(player);
        }
      }, MIN_INTERVAL - elapsed);
    }
    return;
  }

  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }

  state.inFlight = true;
  try {
    await performPlayerMessageEdit(player);
    state.lastEditTime = Date.now();
  } finally {
    state.inFlight = false;
    if (state.pending) {
      state.pending = false;
      state.timer = setTimeout(() => {
        state!.timer = undefined;
        updateActivePlayerMessage(player);
      }, MIN_INTERVAL);
    }
  }
}

async function performPlayerMessageEdit(player: Player) {
  if (!player.textChannelId) return;
  let messageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);

  const channel = (discordClient?.channels.cache.get(player.textChannelId) ||
    await discordClient?.channels.fetch(player.textChannelId).catch(() => null)) as TextChannel | null;
  if (!channel || !channel.isTextBased()) return;

  // Auto-discover existing player message if bot restarted or messageId lost from memory
  if (!messageId) {
    try {
      const recentMsgs = await channel.messages.fetch({ limit: 8 }).catch(() => null);
      const botMsg = recentMsgs?.find((m) => m.author.id === discordClient?.user?.id && m.embeds.length > 0 && m.components.length > 0);
      if (botMsg) {
        messageId = botMsg.id;
        activePlayerMessages.set(player.guildId, messageId);
        player.setData("active_message_id", messageId);
      }
    } catch {}
  }

  if (!messageId) return;

  try {
    const msg = channel.messages.cache.get(messageId) || (await channel.messages.fetch(messageId).catch(() => null));
    if (msg) {
      await msg.edit(buildPlayerMessage(player));
    } else {
      activePlayerMessages.delete(player.guildId);
      player.setData("active_message_id", null);
    }
  } catch (err: any) {
    if (err.code === 10008) {
      // 10008: Unknown Message (deleted by user or mod)
      activePlayerMessages.delete(player.guildId);
      player.setData("active_message_id", null);
    }
  }
}

/**
 * Voice Gate: Validates that the interacting user is currently in the same voice channel as the bot
 */
export async function validateVoiceGate(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  player: Player
): Promise<{ allowed: boolean; error?: string }> {
  const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
  if (!guild) {
    return { allowed: false, error: "❌ This action can only be used inside a server!" };
  }

  // Fast in-memory resolution of user voice channel without network latency
  const memberVoiceChannelId =
    (interaction.member as any)?.voice?.channelId ||
    guild.members.cache.get(interaction.user.id)?.voice?.channelId ||
    (await guild.members.fetch(interaction.user.id).catch(() => null))?.voice?.channelId;

  if (!memberVoiceChannelId) {
    return {
      allowed: false,
      error: "🔒 **Voice Gate Active:** You must be connected to a voice channel to use player controls!",
    };
  }

  if (player.voiceChannelId && memberVoiceChannelId !== player.voiceChannelId) {
    return {
      allowed: false,
      error: `🔒 **Voice Gate Active:** You must be in <#${player.voiceChannelId}> to use player controls!`,
    };
  }

  return { allowed: true };
}


