import { withTimeout } from "../utils/playback.js";
import { sameTitle, sameRecording, hasUnrequestedVersion } from "../utils/trackSelection.js";
import CryptoJS from "crypto-js";
import { parseTrackTitle } from "../utils/formatters.js";
/**
 * Clean and decode HTML entities commonly returned by JioSaavn
 */
function cleanText(text) {
    if (!text)
        return "";
    return text
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .trim();
}
/**
 * Decrypts JioSaavn DES-ECB encrypted media URL and upgrades it to 320 kbps studio master
 */
export function decryptMediaUrl(encryptedUrl, has320kbps = false) {
    if (!encryptedUrl)
        return null;
    try {
        const key = CryptoJS.enc.Utf8.parse("38346591");
        const decrypted = CryptoJS.DES.decrypt(encryptedUrl, key, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7,
        });
        const rawUrl = decrypted.toString(CryptoJS.enc.Utf8);
        if (!rawUrl || !rawUrl.startsWith("http"))
            return null;
        // Direct 320 kbps upgrade
        return has320kbps ? rawUrl.replace(/_96\.mp4|_160\.mp4/, "_320.mp4") : rawUrl;
    }
    catch {
        return null;
    }
}
/**
 * Parses raw JioSaavn API track object into a clean JioSaavnTrack with 320 kbps stream URL
 */
export function parseJioSaavnSong(item) {
    if (!item)
        return null;
    const encUrl = item?.more_info?.encrypted_media_url || item?.encrypted_media_url || item?.encrypted_drm_media_url;
    const has320kbps = [item["320kbps"], item.more_info?.["320kbps"]].some(v => v === true || v === "true");
    const streamUrl = decryptMediaUrl(encUrl, has320kbps);
    if (!streamUrl)
        return null;
    const title = cleanText(item.song || item.title || "");
    const artist = cleanText(item.singers || item.primary_artists || item.more_info?.singers || item.more_info?.artistMap?.primary_artists?.map((a) => a.name).filter(Boolean).join(", ") || item.music || "JioSaavn Artist");
    const album = cleanText(item.album || item.more_info?.album || "");
    const rawImage = item.image || item.more_info?.image || "";
    const artworkUrl = rawImage ? rawImage.replace(/150x150\.jpg|50x50\.jpg/, "500x500.jpg") : "";
    const duration = parseInt(item.duration || item.more_info?.duration || "0", 10);
    const language = (item.language || item.more_info?.language || "global").toLowerCase();
    return {
        id: item.id,
        title,
        artist,
        album,
        year: item.year || item.more_info?.year || "",
        duration,
        artworkUrl,
        streamUrl,
        language,
        has320kbps,
        uri: item.perma_url || (item.id ? `https://www.jiosaavn.com/song/${encodeURIComponent(title)}/${item.id}` : ""),
    };
}
async function safeJsonFetch(url, headers, timeoutMs = 5000) {
    try {
        const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
            return null;
        const text = await res.text();
        if (!text || !text.trim())
            return null;
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
/**
 * Search JioSaavn for tracks matching the query
 */
export async function searchJioSaavn(query, limit = 5) {
    try {
        const parsed = parseTrackTitle(query);
        const cleanQuery = parsed.fullSearchQuery || query.replace(/\|.*/, "").trim();
        const searchUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&includeMetaTags=1&p=1&n=${limit}&q=${encodeURIComponent(cleanQuery)}`;
        const data = await safeJsonFetch(searchUrl, {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "application/json",
        }, 5000);
        const rawResults = data?.results || [];
        if (!Array.isArray(rawResults) || rawResults.length === 0)
            return [];
        const tracks = [];
        for (const item of rawResults) {
            const track = parseJioSaavnSong(item);
            if (track)
                tracks.push(track);
        }
        return tracks;
    }
    catch (err) {
        console.warn("[JioSaavn] Search exception:", err);
        return [];
    }
}
/**
 * Strips YouTube fluff (VEVO, record labels, channels, video/lyric tags) and extracts clean song & artist
 */
export function sanitizeMusicQuery(rawTitle, rawAuthor = "") {
    const parsed = parseTrackTitle(rawTitle, rawAuthor);
    return {
        searchTitle: parsed.songTitle,
        searchArtist: parsed.artist,
        movieOrAlbum: parsed.movieOrAlbum,
        fullQuery: parsed.fullSearchQuery,
    };
}
/**
 * Checks whether a candidate title matches the target song name, accounting for typos and vowel doubling
 */
export function isFuzzyTitleMatch(titleA, titleB) {
    return sameTitle(titleA, titleB);
}
/**
 * Auto-corrects typos in song queries using real-time search suggestion signals
 */
export async function getSpellingSuggestion(query) {
    const cleanQ = query.replace(/\|.*/, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    if (!cleanQ || cleanQ.length < 3)
        return null;
    const candidates = [cleanQ, `${cleanQ} song`];
    for (const q of candidates) {
        try {
            const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
            if (!res.ok)
                continue;
            const data = await res.json();
            if (Array.isArray(data[1]) && data[1].length > 0) {
                for (const item of data[1]) {
                    const cleaned = String(item)
                        .replace(/ songs?.*$/i, "")
                        .replace(/ lyrics.*$/i, "")
                        .replace(/ ringtone.*$/i, "")
                        .replace(/ download.*$/i, "")
                        .trim();
                    if (cleaned && cleaned.toLowerCase() !== cleanQ.toLowerCase()) {
                        return cleaned;
                    }
                }
            }
        }
        catch { }
    }
    return null;
}
/**
 * Resolves a single best matching track from JioSaavn for a given song title and artist with typo correction
 */
export async function resolveJioSaavnTrack(title, artist = "") {
    const { searchTitle, searchArtist, movieOrAlbum, fullQuery } = sanitizeMusicQuery(title, artist);
    const targetSongName = searchTitle || title;
    const queriesToTry = [...new Set([
            fullQuery,
            ...(movieOrAlbum && movieOrAlbum.toLowerCase() !== searchTitle.toLowerCase() ? [`${searchTitle} ${movieOrAlbum}`] : []),
            ...(searchArtist ? [`${searchTitle} ${searchArtist}`] : []),
            searchTitle,
        ].filter(Boolean))];
    for (const q of queriesToTry) {
        const results = await searchJioSaavn(q, 5);
        const match = results.find((t) => sameRecording({ title: t.title, author: t.artist }, { title, author: artist }));
        if (match)
            return match;
    }
    // If still no match, attempt typo auto-correction
    const suggestion = (await getSpellingSuggestion(fullQuery)) || (await getSpellingSuggestion(searchTitle));
    if (suggestion) {
        console.log(`[JioSaavn Resolver] Typo detected in "${fullQuery}". Auto-correcting to "${suggestion}"...`);
        const correctedResults = await searchJioSaavn(suggestion, 5);
        const match = correctedResults.find((t) => sameRecording({ title: t.title, author: t.artist }, { title, author: artist }));
        if (match)
            return match;
    }
    return null;
}
/** Filter before ranking: quality never justifies the wrong language or a repeat. */
export function rankJioSaavnRecommendations(tracks, seedTitle, seedArtist, language, excludeIds, previousTitles, previousArtists = [], seedAlbum = "") {
    const normalized = (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const seedArtistKey = normalized(seedArtist);
    const recentArtistKeys = previousArtists.map(normalized).filter(Boolean);
    const seedAlbumKey = normalized(seedAlbum);
    const valid = tracks.filter(t => !hasUnrequestedVersion(t.title) && Number.isFinite(t.duration) && t.duration >= 60 && t.duration <= 900 &&
        !!t.artist.trim() && !/^(unknown|jiosaavn artist|various artists)$/i.test(t.artist.trim()) &&
        !excludeIds.has(t.id) && !excludeIds.has(t.streamUrl) &&
        (language === "global" || t.language === language) &&
        ![seedTitle, ...previousTitles].some(title => sameTitle(t.title, title)));
    const isRecentArtist = (track) => {
        const artist = normalized(track.artist);
        return recentArtistKeys.some(recent => artist === recent || (recent.length >= 5 && artist.includes(recent)));
    };
    const repeatsSeedArtist = (track) => {
        const artist = normalized(track.artist);
        return !!seedArtistKey && (artist === seedArtistKey || (seedArtistKey.length >= 5 && artist.includes(seedArtistKey)));
    };
    const repeatsAlbum = (track) => !!seedAlbumKey && normalized(track.album) === seedAlbumKey;
    return valid.sort((a, b) => Number(isRecentArtist(a)) - Number(isRecentArtist(b)) ||
        Number(repeatsSeedArtist(a)) - Number(repeatsSeedArtist(b)) ||
        Number(repeatsAlbum(a)) - Number(repeatsAlbum(b)) ||
        Number(b.has320kbps) - Number(a.has320kbps));
}
/** Native "You Might Like" recommendations preserve JioSaavn's catalog similarity signal. */
async function getJioSaavnRecommendations(seedId, limit = 20) {
    if (!seedId)
        return [];
    const url = `https://www.jiosaavn.com/api.php?__call=reco.getreco&_format=json&_marker=0&ctx=web6dot0&pid=${encodeURIComponent(seedId)}`;
    const data = await safeJsonFetch(url, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json",
    }, 5000);
    const raw = Array.isArray(data) ? data : data?.results || data?.songs || data?.list || [];
    return Array.isArray(raw) ? raw.slice(0, limit).map(parseJioSaavnSong).filter((t) => Boolean(t)) : [];
}
/**
 * Generates an autoplay recommendation using JioSaavn's catalog in the exact same language and vibe
 */
export async function findJioSaavnAutoplay(seedTitle, seedArtist, seedLanguage = "global", excludeIds = new Set(), previousTitles = [], seedId = "", previousArtists = [], seedAlbum = "") {
    try {
        const nativeRecommendations = await getJioSaavnRecommendations(seedId);
        const nativeValid = rankJioSaavnRecommendations(nativeRecommendations, seedTitle, seedArtist, seedLanguage, excludeIds, previousTitles, previousArtists, seedAlbum);
        if (nativeValid.length > 0)
            return nativeValid[0];
        const language = seedLanguage === "global" ? "" : seedLanguage;
        const queries = [...new Set([
                `${seedTitle} ${seedArtist} ${language}`.trim(),
                `${seedTitle} ${language}`.trim(),
            ].filter((q) => Boolean(q)))];
        for (const q of queries) {
            const results = await searchJioSaavn(q, 10);
            const valid = rankJioSaavnRecommendations(results, seedTitle, seedArtist, seedLanguage, excludeIds, previousTitles, previousArtists, seedAlbum);
            if (valid.length > 0) {
                // Pick randomly from top 3 to keep discovery fresh
                return valid[0];
            }
        }
    }
    catch { }
    return null;
}
/**
 * Checks whether a given string is a JioSaavn / Saavn URL
 */
export function isJioSaavnUrl(str) {
    if (!str)
        return false;
    return /https?:\/\/(?:www\.|www5\.)?(?:jiosaavn\.com|saavn\.com|jio\.saavn\.com|saavn\.me|jioma\.in)\//i.test(str.trim());
}
/**
 * Parses and resolves a JioSaavn song, album, or playlist URL into 320 kbps studio tracks
 */
export async function resolveJioSaavnUrl(url) {
    if (!isJioSaavnUrl(url))
        return null;
    let finalUrl = url.trim();
    try {
        const head = await fetch(finalUrl, {
            method: "GET",
            redirect: "follow",
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(5000),
        });
        finalUrl = head.url || finalUrl;
    }
    catch { }
    try {
        const parsed = new URL(finalUrl);
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (segments.length === 0)
            return null;
        const isSong = segments.some((s) => s.toLowerCase() === "song");
        const isAlbum = segments.some((s) => s.toLowerCase() === "album");
        const isPlaylist = segments.some((s) => ["playlist", "featured"].includes(s.toLowerCase()));
        const token = segments[segments.length - 1];
        const slug = segments.length >= 2 ? segments[segments.length - 2] : "";
        if (isSong) {
            const apiUrl = `https://www.jiosaavn.com/api.php?__call=webapi.get&token=${encodeURIComponent(token)}&type=song&_format=json&_marker=0&cc=in&includeMetaTags=1`;
            const data = await safeJsonFetch(apiUrl, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" }, 5000);
            if (data) {
                const songs = Array.isArray(data.songs) ? data.songs : Array.isArray(data.list) ? data.list : Object.values(data);
                for (const item of songs) {
                    const track = parseJioSaavnSong(item);
                    if (track && track.uri && new URL(track.uri).pathname.replace(/\/$/, "") === parsed.pathname.replace(/\/$/, ""))
                        return { type: "track", track };
                }
            }
            return null;
        }
        if (isAlbum) {
            const apiUrl = `https://www.jiosaavn.com/api.php?__call=webapi.get&token=${encodeURIComponent(token)}&type=album&_format=json&_marker=0&cc=in`;
            const data = await safeJsonFetch(apiUrl, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" }, 7000);
            if (data) {
                const rawSongs = data?.songs || data?.list || [];
                const tracks = rawSongs.map(parseJioSaavnSong).filter((t) => Boolean(t));
                const title = cleanText(data?.title || data?.name || slug.replace(/-/g, " ") || "JioSaavn Album");
                if (tracks.length > 0) {
                    return { type: "playlist", title, tracks };
                }
            }
        }
        if (isPlaylist) {
            const apiUrl = `https://www.jiosaavn.com/api.php?__call=webapi.get&token=${encodeURIComponent(token)}&type=playlist&_format=json&_marker=0&cc=in`;
            const data = await safeJsonFetch(apiUrl, { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" }, 7000);
            if (data) {
                const rawSongs = data?.songs || data?.list || [];
                const tracks = rawSongs.map(parseJioSaavnSong).filter((t) => Boolean(t));
                const title = cleanText(data?.title || data?.listname || slug.replace(/-/g, " ") || "JioSaavn Playlist");
                if (tracks.length > 0) {
                    return { type: "playlist", title, tracks };
                }
            }
        }
    }
    catch (err) {
        console.warn("[JioSaavn] URL resolution notice:", err);
    }
    return null;
}
/**
 * Resolves a JioSaavnTrack into a playable Lavalink Track across candidate nodes
 */
export async function loadJioSaavnAsLavalinkTrack(jioTrack, requester, candidateNodes) {
    if (!jioTrack?.streamUrl)
        return null;
    // Prefer the player's node and avoid repeating the same HTTP load on duplicate nodes.
    const sortedNodes = candidateNodes.filter((n, i, all) => n?.connected && all.findIndex(x => x?.id === n.id) === i);
    for (const node of sortedNodes) {
        if (!node || !node.connected)
            continue;
        try {
            const res = await withTimeout(node.search({ query: jioTrack.streamUrl }, requester), 4000);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                const trk = res.tracks.find((t) => t.info?.identifier === jioTrack.streamUrl || t.info?.uri === jioTrack.streamUrl);
                if (!trk)
                    continue;
                trk.info.title = jioTrack.title;
                trk.info.author = jioTrack.artist;
                trk.info.artworkUrl = jioTrack.artworkUrl;
                trk.info.uri = jioTrack.uri;
                // Keep the actual HTTP sourceName; userData describes the catalog.
                trk.userData = {
                    ...(trk.userData || {}),
                    isJioSaavn: true,
                    jioId: jioTrack.id,
                    streamUri: jioTrack.streamUrl,
                    quality: jioTrack.has320kbps ? "320kbps" : "unknown",
                    album: jioTrack.album,
                    year: jioTrack.year,
                    language: jioTrack.language,
                };
                trk.requester = requester;
                return { track: trk, node };
            }
        }
        catch {
            // Continue to next candidate node
        }
    }
    return null;
}
