import { config } from "../config.js";
// In-memory LRU cache to respond in 0ms for repeated keystrokes
const suggestionCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Spotify token management for official Spotify Web API
let spotifyToken = null;
let spotifyTokenExpiry = 0;
async function getSpotifyToken() {
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
            signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
            const data = (await resp.json());
            spotifyToken = data.access_token;
            spotifyTokenExpiry = Date.now() + data.expires_in * 1000;
            console.log("[Spotify Auth] Acquired fresh access token for autocomplete.");
            return spotifyToken;
        }
    }
    catch (err) {
        console.warn("[Spotify Auth Error]:", err);
    }
    return null;
}
function formatTime(seconds) {
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${mm}:${ss}`;
}
/**
 * Searches Spotify for real tracks & playlists (matching FlaviBot layout)
 */
async function searchSpotify(query, token) {
    const suggestions = [];
    try {
        const signal = AbortSignal.timeout(1200);
        const resp = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track,playlist&limit=12`, {
            headers: { Authorization: `Bearer ${token}` },
            signal,
        });
        if (resp.ok) {
            const data = (await resp.json());
            // 1. Spotify Tracks: 🎵 Artist - Title - MM:SS
            if (Array.isArray(data.tracks?.items)) {
                for (const t of data.tracks.items) {
                    if (suggestions.length >= 10)
                        break;
                    const artist = t.artists?.map((a) => a.name).join(", ") || "Unknown Artist";
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
                    if (suggestions.length >= 15)
                        break;
                    if (!p)
                        continue;
                    const owner = p.owner?.display_name || "Spotify";
                    const trackCount = p.tracks?.total || 0;
                    const name = `📁 ${p.name} (${trackCount} tracks) by ${owner}`.substring(0, 100);
                    const value = p.external_urls?.spotify || p.name;
                    suggestions.push({ name, value });
                }
            }
        }
    }
    catch (err) {
        // Network / abort error
    }
    return suggestions;
}
/**
 * Searches Apple Music / iTunes Music Catalog API (Zero-config, sub-500ms, bounded requests)
 */
async function searchAppleMusic(query) {
    const suggestions = [];
    try {
        const signal = AbortSignal.timeout(1400);
        const [songResp, albumResp] = await Promise.all([
            fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=14`, { signal }),
            fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=3`, { signal }),
        ]);
        // 1. Song Tracks: 🎵 Artist - Title - MM:SS
        if (songResp.ok) {
            const songData = (await songResp.json());
            if (Array.isArray(songData.results)) {
                for (const t of songData.results) {
                    if (suggestions.length >= 12)
                        break;
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
            const albumData = (await albumResp.json());
            if (Array.isArray(albumData.results)) {
                for (const a of albumData.results) {
                    if (suggestions.length >= 16)
                        break;
                    const artist = (a.artistName || "Unknown").replace(/,.*$/, "").replace(/&.*$/, "").trim();
                    const name = `📁 ${a.collectionName} (${a.trackCount} tracks) by ${artist}`.substring(0, 100);
                    const value = `${a.collectionName} full album`.substring(0, 100);
                    if (!suggestions.some((s) => s.value.toLowerCase() === value.toLowerCase())) {
                        suggestions.push({ name, value });
                    }
                }
            }
        }
    }
    catch (err) {
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
export async function getMusicSuggestions(query, userFavorites = [], userPlaylists = [], username = "You") {
    const trimmed = query.trim();
    // Case 1: Empty / Very Short Query -> Return User Liked Songs + Playlists + Curated Hits
    if (!trimmed || trimmed.length < 1) {
        const results = [];
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
            if (results.length >= 10)
                break;
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
    const results = [];
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
    // Cache only public catalog results; personal favorites/playlists stay request-local.
    let catalog = cached && Date.now() - cached.timestamp < CACHE_TTL_MS ? cached.data : undefined;
    if (!catalog) {
        const token = await getSpotifyToken();
        // Query providers concurrently to keep autocomplete responsive on partial outages.
        const [spotify, apple] = await Promise.all([
            token ? searchSpotify(trimmed, token) : Promise.resolve([]),
            searchAppleMusic(trimmed),
        ]);
        catalog = [...spotify, ...apple];
        if (catalog.length) {
            if (suggestionCache.size >= 500)
                suggestionCache.delete(suggestionCache.keys().next().value);
            suggestionCache.set(cacheKey, { timestamp: Date.now(), data: catalog });
        }
    }
    for (const item of catalog) {
        if (!results.some(r => r.value.toLowerCase() === item.value.toLowerCase()))
            results.push(item);
    }
    const finalResults = results.filter(item => item.value.length <= 100).slice(0, 20);
    return finalResults;
}
