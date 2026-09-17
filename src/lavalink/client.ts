import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  GuildMember,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import { LavalinkManager, Player, Track } from "lavalink-client";
import { config } from "../config.js";
import { buildPlayerMessage } from "./playerUI.js";
import { getChannelBitrateInfo } from "../utils/formatters.js";
import { is247Enabled } from "../utils/twentyFourSeven.js";

export let lavalink: LavalinkManager;
export let discordClient: Client;

// Track active player messages so we can update or clean them up
export const activePlayerMessages = new Map<string, string>(); // guildId -> messageId

export function initLavalink(client: Client) {
  discordClient = client;
  lavalink = new LavalinkManager({
    nodes: [
      {
        authorization: "free",
        host: "lavalink-v4.triniumhost.com",
        port: 443,
        secure: true,
        id: "Trinium-FastNode",
      },
      {
        authorization: config.lavalink.password,
        host: config.lavalink.host,
        port: config.lavalink.port,
        secure: config.lavalink.secure,
        id: "Jirayu-Node",
      },
    ],
    sendToShard: (guildId, payload) => {
      client.guilds.cache.get(guildId)?.shard.send(payload);
    },
    autoSkip: true,
    autoMove: true,
    playerOptions: {
      clientBasedPositionUpdateInterval: 500,
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

  // Dedicated Live Player Ticker (every 4.5 seconds while playing)
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
    }, 4500);
    liveTickers.set(player.guildId, ticker);
  }

  function stopLivePlayerTicker(guildId: string) {
    const ticker = liveTickers.get(guildId);
    if (ticker) {
      clearInterval(ticker);
      liveTickers.delete(guildId);
    }
  }

  lavalink.on("playerUpdate", async (oldPlayer, player) => {
    if (!player.playing || player.paused) return;
    await updateActivePlayerMessage(player);
  });

  // Player Events
  lavalink.on("trackStart", async (player: Player, track: Track | null) => {
    if (!player.textChannelId || !track) return;
    const channel = (client.channels.cache.get(player.textChannelId) ||
      await client.channels.fetch(player.textChannelId).catch(() => null)) as TextChannel | null;
    if (!channel || !channel.isTextBased()) return;

    try {
      // Clean up previous active player message so chat stays neat
      const prevMessageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);
      if (prevMessageId) {
        channel.messages.delete(prevMessageId).catch(() => {});
      }

      const playerMsgOptions = buildPlayerMessage(player, track);
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
            }).catch(() => {});
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
      if (is247) {
        channel.send("🎶 Queue finished. Staying **24/7** in voice channel! Add more songs with `/play`.").catch(() => {});
      } else {
        channel.send("🎶 Queue finished. Add more songs with `/play`!").catch(() => {});
      }
    }
  });

  lavalink.on("trackEnd", (player: Player, track, payload) => {
    console.log(`[Player] trackEnd: "${track?.info.title}" | Reason: ${payload.reason} | Position: ${player.position}ms`);
    if (!player.queue.current) {
      stopLivePlayerTicker(player.guildId);
    }
  });

  lavalink.on("trackError", async (player: Player, track, payload) => {
    console.error(`[Lavalink] Error playing "${track?.info.title}":`, payload);

    // Auto-recovery for Spotify tracks that fail to stream on Lavalink: search and play on YouTube Music
    if (track?.info.sourceName === "spotify" && !player.getData("recovering_track")) {
      try {
        player.setData("recovering_track", true);
        const fallbackQuery = `${track.info.title} ${track.info.author || ""}`.trim();
        console.log(`[Spotify Recovery] Auto-recovering "${fallbackQuery}" via YouTube Music...`);
        const fallbackRes = await player.search({ query: fallbackQuery, source: "ytmsearch" }, track.requester);
        if (fallbackRes?.tracks?.[0]) {
          const fallbackTrack = fallbackRes.tracks[0];
          fallbackTrack.requester = track.requester;
          await player.queue.add(fallbackTrack, 0);
          await player.skip();
          setTimeout(() => player.setData("recovering_track", false), 3000);
          return;
        }
      } catch (err) {
        console.error("[Spotify Recovery Failed]:", err);
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

/**
 * Updates the active Now Playing message in the text channel (if one exists)
 */
export async function updateActivePlayerMessage(player: Player) {
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
    }
  } catch (err) {
    // If message is deleted or cannot be edited, quietly ignore
  }
}

/**
 * Voice Gate: Validates that the interacting user is currently in the same voice channel as the bot
 */
export async function validateVoiceGate(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  player: Player
): Promise<{ allowed: boolean; error?: string }> {
  const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
  if (!guild) {
    return { allowed: false, error: "❌ This action can only be used inside a server!" };
  }

  const member = guild.members.cache.get(interaction.user.id) || await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.voice?.channelId) {
    return {
      allowed: false,
      error: "🔒 **Voice Gate Active:** You must be connected to a voice channel to use player controls!",
    };
  }

  if (player.voiceChannelId && member.voice.channelId !== player.voiceChannelId) {
    return {
      allowed: false,
      error: `🔒 **Voice Gate Active:** You must be in <#${player.voiceChannelId}> to use player controls!`,
    };
  }

  return { allowed: true };
}


