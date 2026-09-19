import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, TextChannel, VoiceBasedChannel } from "discord.js";
import { Track } from "lavalink-client";
import { getBestNode, lavalink } from "../lavalink/client.js";
import { autoDeleteMessage } from "./cleanup.js";
import { formatDuration } from "./formatters.js";
import { is247Enabled } from "./twentyFourSeven.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");

export interface SerializedSession {
  guildId: string;
  voiceChannelId: string;
  textChannelId?: string;
  volume: number;
  repeatMode: string;
  position: number;
  autoplay: boolean;
  normalized: boolean;
  currentTrack?: any;
  queueTracks: any[];
  savedAt: number;
}

function ensureDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let lastSavedPayload = "";

/**
 * Saves all active player states, queues, and playback timestamps to disk
 */
export function saveActiveSessions(): void {
  if (!lavalink || !lavalink.players) return;

  try {
    ensureDirectory();
    const sessions: Record<string, SerializedSession> = {};

    for (const [guildId, player] of lavalink.players) {
      if (!player.voiceChannelId) continue;
      // Only persist if something is actively playing or queued
      if (!player.queue.current && player.queue.tracks.length === 0) continue;

      sessions[guildId] = {
        guildId,
        voiceChannelId: player.voiceChannelId,
        textChannelId: player.textChannelId || undefined,
        volume: player.volume || 100,
        repeatMode: player.repeatMode || "off",
        // Round position to nearest 5s to avoid disk churn on negligible timestamp delta
        position: Math.round((player.position || 0) / 5000) * 5000,
        autoplay: Boolean(player.getData("autoplay") ?? true),
        normalized: Boolean(player.getData("normalized") ?? false),
        currentTrack: player.queue.current ? cleanTrackForSerialization(player.queue.current) : undefined,
        queueTracks: player.queue.tracks.slice(0, 50).map((t) => cleanTrackForSerialization(t)),
        savedAt: Date.now(),
      };
    }

    const payload = JSON.stringify(sessions, null, 2);
    // Skip synchronous disk write if state has not meaningfully changed
    if (payload === lastSavedPayload) return;
    lastSavedPayload = payload;

    fs.writeFileSync(SESSIONS_FILE, payload, "utf-8");
  } catch (err) {
    console.warn("[Session Recovery] Error saving sessions:", err);
  }
}

/**
 * Strips circular references or non-serializable objects from tracks
 */
function cleanTrackForSerialization(track: any): any {
  return {
    encoded: track.encoded,
    info: { ...track.info },
    pluginInfo: track.pluginInfo,
    userData: track.userData,
  };
}

/**
 * Removes a guild session when playback legitimately stops
 */
export function clearGuildSession(guildId: string): void {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const data = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const sessions: Record<string, SerializedSession> = JSON.parse(data || "{}");
    if (sessions[guildId]) {
      delete sessions[guildId];
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), "utf-8");
    }
  } catch {}
}

let saveInterval: NodeJS.Timeout | null = null;

/**
 * Starts automatic continuous session checkpointing every 12 seconds
 */
export function startSessionAutoSave(): void {
  if (saveInterval) clearInterval(saveInterval);
  saveInterval = setInterval(() => {
    saveActiveSessions();
  }, 12000);

  // Hook process shutdown signals to guarantee a clean flush to disk
  const onShutdown = () => {
    console.log("[Session Recovery] Saving active audio sessions before container shutdown...");
    saveActiveSessions();
  };

  process.once("SIGINT", onShutdown);
  process.once("SIGTERM", onShutdown);
  process.once("beforeExit", onShutdown);
}

/**
 * Restores interrupted player sessions across voice channels after bot restart
 */
export async function restoreSessions(client: Client): Promise<void> {
  if (!fs.existsSync(SESSIONS_FILE)) return;

  try {
    const data = fs.readFileSync(SESSIONS_FILE, "utf-8");
    const sessions: Record<string, SerializedSession> = JSON.parse(data || "{}");
    const sessionList = Object.values(sessions);

    if (sessionList.length === 0) return;

    console.log(`[Session Recovery] Found ${sessionList.length} saved audio session(s). Resuming playback...`);

    for (const session of sessionList) {
      try {
        // Discard stale sessions older than 4 hours
        if (Date.now() - session.savedAt > 4 * 60 * 60 * 1000) {
          clearGuildSession(session.guildId);
          continue;
        }

        const guild = client.guilds.cache.get(session.guildId) || await client.guilds.fetch(session.guildId).catch(() => null);
        if (!guild) continue;

        const voiceChannel = guild.channels.cache.get(session.voiceChannelId) as VoiceBasedChannel | undefined;
        if (!voiceChannel || !voiceChannel.isVoiceBased()) continue;

        const permissions = voiceChannel.permissionsFor(client.user!);
        if (!permissions?.has("Connect") || !permissions?.has("Speak")) continue;

        // Do not resume music in an empty voice channel unless 24/7 mode is explicitly enabled
        const humanMembers = voiceChannel.members.filter((m) => !m.user.bot);
        if (humanMembers.size === 0 && !is247Enabled(session.guildId)) {
          console.log(`[Session Recovery] Discarding session for guild "${guild.name}" — voice channel is empty.`);
          clearGuildSession(session.guildId);
          continue;
        }

        const targetNode = getBestNode();
        let player = lavalink.getPlayer(session.guildId);

        if (!player) {
          player = lavalink.createPlayer({
            guildId: session.guildId,
            voiceChannelId: session.voiceChannelId,
            textChannelId: session.textChannelId,
            selfDeaf: true,
            selfMute: false,
            volume: session.volume || 100,
            instaUpdateFiltersFix: true,
            applyVolumeAsFilter: false,
            ...(targetNode ? { node: targetNode } : {}),
          });
        }

        player.setData("autoplay", session.autoplay);
        player.setData("normalized", session.normalized);
        if (session.repeatMode) {
          await player.setRepeatMode(session.repeatMode as any).catch(() => {});
        }

        if (!player.connected) {
          await player.connect();
        }

        // Restore queued tracks
        if (Array.isArray(session.queueTracks)) {
          for (const rawTrack of session.queueTracks) {
            await player.queue.add(rawTrack);
          }
        }

        // Restore current track and seek to the exact second
        if (session.currentTrack) {
          const seekPos = Math.max(0, session.position || 0);
          await player.play({
            clientTrack: session.currentTrack,
            position: seekPos,
          });

          console.log(
            `[Session Recovery] Resumed "${session.currentTrack.info?.title}" in "${guild.name}" at ${formatDuration(seekPos)}`
          );

          if (session.textChannelId) {
            const channel = (client.channels.cache.get(session.textChannelId) ||
              await client.channels.fetch(session.textChannelId).catch(() => null)) as TextChannel | null;
            if (channel && channel.isTextBased()) {
              channel.send({
                content: `🔄 **Session Restored:** Resumed playback of **[${session.currentTrack.info?.title}](${session.currentTrack.info?.uri})** at \`${formatDuration(seekPos)}\` following server reboot!`,
              }).then((msg) => autoDeleteMessage(msg, 10000)).catch(() => {});
            }
          }
        }
      } catch (err: any) {
        console.warn(`[Session Recovery] Failed to restore session for guild ${session.guildId}:`, err?.message || err);
      }
    }
  } catch (err) {
    console.error("[Session Recovery] Error reading session file:", err);
  }
}
