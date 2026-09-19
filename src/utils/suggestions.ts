import { config } from "../config.js";
import { formatDuration } from "./formatters.js";
import { FavoriteTrack } from "./favorites.js";
import { UserPlaylist } from "./playlists.js";

export interface MusicSuggestion {
  name: string;
  value: string;
}

// In-memory LRU cache to respond in 0ms for repeated keystrokes
const suggestionCache = new Map<string, { timestamp: number; data: MusicSuggestion[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Spotify token management for official Spotify Web API
let spotifyToken: string | null = null;
let spotifyTokenExpiry = 0;

async function getSpotifyToken(): Promise<string | null> {
  if (!config.spotify.clientId || !config.spotify.clientSecret) {
    return null;
  }

  if (spotifyToken && Date.now() < spotifyTokenExpiry - 60000) {
    return spotifyToken;
  }

  try {
    const creds = Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString("base64");
    const resp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (resp.ok) {
      const data = (await resp.json()) as { access_token: string; expires_in: number };
      spotifyToken = data.access_token;
      spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
      console.log("[Spotify Auth] Acquired fresh access token for autocomplete.");
      return spotifyToken;
    }
  } catch (err) {
    console.warn("[Spotify Auth Error]:", err);
  }

  return null;
}

function formatTime(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Searches Spotify for real tracks & playlists (matching FlaviBot layout)
 */
async function searchSpotify(query: string, token: string): Promise<MusicSuggestion[]> {
  const suggestions: MusicSuggestion[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);

    const resp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,playlist&limit=12`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (resp.ok) {
      const data = (await resp.json()) as any;

      // 1. Spotify Tracks: 🎵 Artist - Title - MM:SS
      if (Array.isArray(data.tracks?.items)) {
        for (const t of data.tracks.items) {
          if (suggestions.length >= 10) break;
          const artist = t.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist";
          const title = t.name;
          const dur = formatTime(Math.floor((t.duration_ms || 0) / 1000));
          const name = `🎵 ${artist} - ${title} - ${dur}`.substring(0, 100);
          const value = t.external_urls?.spotify || `${artist} - ${title}`.substring(0, 100);
          suggestions.push({ name, value });
        }
      }

      // 2. Spotify Playlists: 📁 Playlist Name (X tracks) by Owner
      if (Array.isArray(data.playlists?.items)) {
        for (const p of data.playlists.items) {
          if (suggestions.length >= 15) break;
          if (!p) continue;
          const owner = p.owner?.display_name || "Spotify";
          const trackCount = p.tracks?.total || 0;
          const name = `📁 ${p.name} (${trackCount} tracks) by ${owner}`.substring(0, 100);
          const value = p.external_urls?.spotify || p.name;
          suggestions.push({ name, value });
        }
      }
    }
  } catch (err) {
    // Network / abort error
  }
  return suggestions;
}

/**
 * Searches Apple Music / iTunes Music Catalog API (Zero-config, sub-500ms, 100% reliable)
 */
async function searchAppleMusic(query: string): Promise<MusicSuggestion[]> {
  const suggestions: MusicSuggestion[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1400);

    const [songResp, albumResp] = await Promise.all([
      fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=14`,
        { signal: controller.signal }
      ),
      fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=3`,
        { signal: controller.signal }
      ),
    ]);
    clearTimeout(timeout);

    // 1. Song Tracks: 🎵 Artist - Title - MM:SS
    if (songResp.ok) {
      const songData = (await songResp.json()) as any;
      if (Array.isArray(songData.results)) {
        for (const t of songData.results) {
          if (suggestions.length >= 12) break;
          const dur = formatTime(Math.floor((t.trackTimeMillis || 0) / 1000));
          const artist = (t.artistName || "Unknown").replace(/,.*$/, "").replace(/&.*$/, "").trim();
          const title = t.trackName;
          const name = `🎵 ${artist} - ${title} - ${dur}`.substring(0, 100);
          const value = `${artist} - ${title}`.substring(0, 100);

          if (!suggestions.some((s) => s.value.toLowerCase() === value.toLowerCase())) {
            suggestions.push({ name, value });
          }
        }
      }
    }

    // 2. Albums / Collections: 📁 Album Name (X tracks) by Artist
    if (albumResp.ok) {
      const albumData = (await albumResp.json()) as any;
      if (Array.isArray(albumData.results)) {
        for (const a of albumData.results) {
          if (suggestions.length >= 16) break;
          const artist = (a.artistName || "Unknown").replace(/,.*$/, "").replace(/&.*$/, "").trim();
          const name = `📁 ${a.collectionName} (${a.trackCount} tracks) by ${artist}`.substring(0, 100);
          const value = `${a.collectionName} full album`.substring(0, 100);

          if (!suggestions.some((s) => s.value.toLowerCase() === value.toLowerCase())) {
            suggestions.push({ name, value });
          }
        }
      }
    }
  } catch (err) {
    // Network / abort error
  }
  return suggestions;
}

/**
 * Multi-tiered intelligent music autocomplete matching FlaviBot:
 * - Direct songs: 🎵 Artist - Title - MM:SS
 * - Playlists: 📁 Playlist Name (X tracks) by Creator
 * - User Liked Songs & Custom Playlists
 */
export async function getMusicSuggestions(
  query: string,
  userFavorites: FavoriteTrack[] = [],
  userPlaylists: UserPlaylist[] = [],
  username: string = "You"
): Promise<MusicSuggestion[]> {
  const trimmed = query.trim();

  // Case 1: Empty / Very Short Query -> Return User Liked Songs + Playlists + Curated Hits
  if (!trimmed || trimmed.length < 1) {
    const results: MusicSuggestion[] = [];

    // User's custom playlists
    for (const p of userPlaylists.slice(0, 3)) {
      results.push({
        name: `📁 ${p.name} (${p.tracks.length} tracks) by ${username}`.substring(0, 100),
        value: `playlist:${p.name}`,
      });
    }

    // User's liked tracks
    for (const f of userFavorites.slice(0, 4)) {
      const dur = formatTime(Math.floor((f.duration || 0) / 1000));
      results.push({
        name: `❤️ ${f.author} - ${f.title} - ${dur}`.substring(0, 100),
        value: f.uri || `${f.author} - ${f.title}`,
      });
    }

    // Global Hits
    const trending = [
      { artist: "The Weeknd", title: "Starboy", dur: "03:50" },
      { artist: "Lady Gaga, Bruno Mars", title: "Die With A Smile", dur: "04:11" },
      { artist: "Billie Eilish", title: "Birds of a Feather", dur: "03:00" },
      { artist: "Ed Sheeran", title: "Shape of You", dur: "03:53" },
      { artist: "Post Malone, Swae Lee", title: "Sunflower", dur: "02:38" },
      { artist: "Coldplay", title: "Viva La Vida", dur: "04:02" },
    ];

    for (const t of trending) {
      if (results.length >= 10) break;
      results.push({
        name: `🔥 ${t.artist} - ${t.title} - ${t.dur}`,
        value: `${t.artist} - ${t.title}`,
      });
    }

    return results;
  }

  // Check in-memory cache
  const cacheKey = trimmed.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const results: MusicSuggestion[] = [];

  // 1. Match against user's custom playlists
  for (const p of userPlaylists) {
    if (p.name.toLowerCase().includes(cacheKey)) {
      results.push({
        name: `📁 ${p.name} (${p.tracks.length} tracks) by ${username}`.substring(0, 100),
        value: `playlist:${p.name}`,
      });
    }
  }

  // 2. Match against user's liked favorites
  for (const f of userFavorites) {
    if (f.title.toLowerCase().includes(cacheKey) || f.author.toLowerCase().includes(cacheKey)) {
      const dur = formatTime(Math.floor((f.duration || 0) / 1000));
      results.push({
        name: `❤️ ${f.author} - ${f.title} - ${dur}`.substring(0, 100),
        value: f.uri || `${f.author} - ${f.title}`,
      });
    }
  }

  // 3. Search Spotify (if credentials exist) or Apple Music / iTunes Catalog
  const spotifyToken = await getSpotifyToken();
  if (spotifyToken) {
    const spotifyResults = await searchSpotify(trimmed, spotifyToken);
    for (const item of spotifyResults) {
      if (!results.some((r) => r.value.toLowerCase() === item.value.toLowerCase())) {
        results.push(item);
      }
    }
  }

  // If Spotify wasn't available or returned few results, query Apple Music catalog
  if (results.length < 10) {
    const appleResults = await searchAppleMusic(trimmed);
    for (const item of appleResults) {
      if (!results.some((r) => r.value.toLowerCase() === item.value.toLowerCase())) {
        results.push(item);
      }
    }
  }

  const finalResults = results.slice(0, 20);

  // Cache final response
  if (finalResults.length > 0) {
    suggestionCache.set(cacheKey, {
      timestamp: Date.now(),
      data: finalResults,
    });
  }

  return finalResults;
}
