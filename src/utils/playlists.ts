import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFavorites } from "./favorites.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const PLAYLISTS_FILE = path.join(DATA_DIR, "playlists.json");

export interface PlaylistTrack {
  title: string;
  uri: string;
  author: string;
  duration: number;
  artworkUrl?: string;
  addedAt: number;
}

export interface UserPlaylist {
  name: string;
  createdAt: number;
  updatedAt: number;
  tracks: PlaylistTrack[];
}

// userId -> Map<playlistNameLower, UserPlaylist>
const playlistsCache = new Map<string, Map<string, UserPlaylist>>();

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PLAYLISTS_FILE)) {
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify({}), "utf-8");
  }
}

export function loadPlaylists(): void {
  try {
    ensureFile();
    const data = fs.readFileSync(PLAYLISTS_FILE, "utf-8");
    const json = JSON.parse(data || "{}");
    playlistsCache.clear();

    for (const [userId, playlistsObj] of Object.entries(json)) {
      const userMap = new Map<string, UserPlaylist>();
      if (typeof playlistsObj === "object" && playlistsObj !== null) {
        for (const [nameKey, p] of Object.entries(playlistsObj as Record<string, any>)) {
          userMap.set(nameKey.toLowerCase(), {
            name: p.name || nameKey,
            createdAt: p.createdAt || Date.now(),
            updatedAt: p.updatedAt || Date.now(),
            tracks: Array.isArray(p.tracks) ? p.tracks : [],
          });
        }
      }
      playlistsCache.set(userId, userMap);
    }
    console.log(`[Playlists] Loaded custom playlists for ${playlistsCache.size} user(s).`);
  } catch (err) {
    console.error("[Playlists] Failed to load playlists:", err);
  }
}

function savePlaylists(): void {
  try {
    ensureFile();
    const obj: Record<string, Record<string, UserPlaylist>> = {};
    for (const [userId, userMap] of playlistsCache.entries()) {
      obj[userId] = {};
      for (const [nameKey, playlist] of userMap.entries()) {
        obj[userId][nameKey] = playlist;
      }
    }
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.error("[Playlists] Failed to save playlists:", err);
  }
}

/**
 * Gets all playlists for a user, including dynamic "❤️ Liked Songs" from favorites.
 */
export function getUserPlaylists(userId: string): UserPlaylist[] {
  const result: UserPlaylist[] = [];

  // 1. Liked Songs (Favorites integration)
  const favorites = getFavorites(userId);
  if (favorites.length > 0) {
    result.push({
      name: "❤️ Liked Songs",
      createdAt: favorites[0]?.addedAt || Date.now(),
      updatedAt: favorites[favorites.length - 1]?.addedAt || Date.now(),
      tracks: favorites.map((f) => ({
        title: f.title,
        uri: f.uri,
        author: f.author,
        duration: f.duration,
        artworkUrl: f.artworkUrl,
        addedAt: f.addedAt,
      })),
    });
  }

  // 2. Custom User Playlists
  const userMap = playlistsCache.get(userId);
  if (userMap) {
    for (const p of userMap.values()) {
      result.push(p);
    }
  }

  return result;
}

/**
 * Resolves a specific playlist by name (case-insensitive, matching "liked" to Liked Songs).
 */
export function getPlaylist(userId: string, name: string): UserPlaylist | null {
  const cleanName = name.trim().toLowerCase();

  // Check Liked Songs virtual playlist
  if (cleanName === "liked songs" || cleanName === "liked" || cleanName === "favorites" || cleanName === "❤️ liked songs") {
    const favorites = getFavorites(userId);
    return {
      name: "❤️ Liked Songs",
      createdAt: favorites[0]?.addedAt || Date.now(),
      updatedAt: Date.now(),
      tracks: favorites.map((f) => ({
        title: f.title,
        uri: f.uri,
        author: f.author,
        duration: f.duration,
        artworkUrl: f.artworkUrl,
        addedAt: f.addedAt,
      })),
    };
  }

  const userMap = playlistsCache.get(userId);
  return userMap?.get(cleanName) || null;
}

/**
 * Creates a new custom playlist
 */
export function createPlaylist(userId: string, name: string): { success: boolean; error?: string; playlist?: UserPlaylist } {
  const cleanName = name.trim();
  const key = cleanName.toLowerCase();

  if (key === "liked songs" || key === "favorites" || key === "❤️ liked songs") {
    return { success: false, error: "❌ 'Liked Songs' is a reserved automatic playlist generated from your liked tracks!" };
  }

  let userMap = playlistsCache.get(userId);
  if (!userMap) {
    userMap = new Map<string, UserPlaylist>();
    playlistsCache.set(userId, userMap);
  }

  if (userMap.has(key)) {
    return { success: false, error: `❌ A playlist named **${cleanName}** already exists!` };
  }

  if (userMap.size >= 25) {
    return { success: false, error: "❌ You have reached the maximum limit of 25 custom playlists." };
  }

  const newPlaylist: UserPlaylist = {
    name: cleanName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tracks: [],
  };

  userMap.set(key, newPlaylist);
  savePlaylists();
  return { success: true, playlist: newPlaylist };
}

/**
 * Adds a track to an existing playlist
 */
export function addSongToPlaylist(
  userId: string,
  name: string,
  track: PlaylistTrack
): { success: boolean; error?: string; totalTracks?: number } {
  const cleanKey = name.trim().toLowerCase();
  const userMap = playlistsCache.get(userId);
  const playlist = userMap?.get(cleanKey);

  if (!playlist) {
    return { success: false, error: `❌ Playlist **${name}** not found. Create it first with \`/playlist create\`!` };
  }

  if (playlist.tracks.length >= 250) {
    return { success: false, error: "❌ Playlist reached maximum capacity of 250 songs." };
  }

  // Check duplicate uri
  if (playlist.tracks.some((t) => t.uri === track.uri)) {
    return { success: false, error: `⚠️ **${track.title}** is already in this playlist!` };
  }

  playlist.tracks.push(track);
  playlist.updatedAt = Date.now();
  savePlaylists();

  return { success: true, totalTracks: playlist.tracks.length };
}

/**
 * Saves all tracks from an active queue into a playlist
 */
export function addQueueToPlaylist(
  userId: string,
  name: string,
  tracks: PlaylistTrack[]
): { success: boolean; error?: string; addedCount?: number; totalTracks?: number } {
  const cleanKey = name.trim().toLowerCase();
  let userMap = playlistsCache.get(userId);
  if (!userMap) {
    userMap = new Map<string, UserPlaylist>();
    playlistsCache.set(userId, userMap);
  }

  let playlist = userMap.get(cleanKey);
  if (!playlist) {
    playlist = {
      name: name.trim(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tracks: [],
    };
    userMap.set(cleanKey, playlist);
  }

  let added = 0;
  const existingUris = new Set(playlist.tracks.map((t) => t.uri));

  for (const t of tracks) {
    if (playlist.tracks.length >= 300) break;
    if (!existingUris.has(t.uri)) {
      playlist.tracks.push(t);
      existingUris.add(t.uri);
      added++;
    }
  }

  playlist.updatedAt = Date.now();
  savePlaylists();

  return { success: true, addedCount: added, totalTracks: playlist.tracks.length };
}

/**
 * Deletes a custom playlist
 */
export function deletePlaylist(userId: string, name: string): { success: boolean; error?: string } {
  const cleanKey = name.trim().toLowerCase();
  const userMap = playlistsCache.get(userId);

  if (!userMap || !userMap.has(cleanKey)) {
    return { success: false, error: `❌ Playlist **${name}** not found.` };
  }

  userMap.delete(cleanKey);
  savePlaylists();
  return { success: true };
}
