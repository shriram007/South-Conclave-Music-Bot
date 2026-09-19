import CryptoJS from "crypto-js";
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
export function decryptMediaUrl(encryptedUrl) {
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
        return rawUrl.replace(/_96\.mp4|_160\.mp4/, "_320.mp4");
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
        const cleanQuery = query
            .replace(/\|.*/, "")
            .replace(/\[.*?\]/g, "")
            .replace(/\(.*?\)/g, "")
            .replace(/official video/gi, "")
            .replace(/video song/gi, "")
            .replace(/lyric video/gi, "")
            .replace(/audio song/gi, "")
            .trim();
        const searchUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&includeMetaTags=1&p=1&n=${limit}&q=${encodeURIComponent(cleanQuery)}`;
        const res = await fetch(searchUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "application/json",
            },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok)
            return [];
        const data = await res.json();
        const rawResults = data?.results || [];
        if (!Array.isArray(rawResults) || rawResults.length === 0)
            return [];
        const tracks = [];
        for (const item of rawResults) {
            const encUrl = item?.more_info?.encrypted_media_url || item?.encrypted_media_url || item?.encrypted_drm_media_url;
            const streamUrl = decryptMediaUrl(encUrl);
            if (!streamUrl)
                continue;
            const title = cleanText(item.song || item.title || "");
            const artist = cleanText(item.singers || item.primary_artists || item.more_info?.singers || item.more_info?.artistMap?.primary_artists?.[0]?.name || item.music || "JioSaavn Artist");
            const album = cleanText(item.album || item.more_info?.album || "");
            const rawImage = item.image || item.more_info?.image || "";
            const artworkUrl = rawImage ? rawImage.replace(/150x150\.jpg|50x50\.jpg/, "500x500.jpg") : "";
            const duration = parseInt(item.duration || item.more_info?.duration || "0", 10);
            const language = (item.language || "tamil").toLowerCase();
            tracks.push({
                id: item.id,
                title,
                artist,
                album,
                year: item.year || item.more_info?.year || "",
                duration,
                artworkUrl,
                streamUrl,
                language,
                has320kbps: item["320kbps"] === "true" || item.more_info?.["320kbps"] === "true",
                uri: item.perma_url || `https://www.jiosaavn.com/song/${encodeURIComponent(title)}/${item.id}`,
            });
        }
        return tracks;
    }
    catch (err) {
        console.warn("[JioSaavn] Search exception:", err);
        return [];
    }
}
/**
 * Resolves a single best matching track from JioSaavn for a given song title and artist
 */
export async function resolveJioSaavnTrack(title, artist = "") {
    const query = `${title} ${artist}`.trim();
    const results = await searchJioSaavn(query, 5);
    if (results.length === 0)
        return null;
    // Exact or close title match priority
    const cleanTarget = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const best = results.find((t) => {
        const cleanCand = t.title.toLowerCase().replace(/[^a-z0-9]/g, "");
        return cleanCand.includes(cleanTarget) || cleanTarget.includes(cleanCand);
    });
    return best || results[0] || null;
}
/**
 * Generates an autoplay recommendation using JioSaavn's catalog in the exact same language and vibe
 */
export async function findJioSaavnAutoplay(seedTitle, seedArtist, seedLanguage = "tamil", excludeIds = new Set()) {
    try {
        const queries = [
            `${seedArtist} ${seedLanguage} hits`,
            `${seedTitle} ${seedLanguage} radio`,
            `${seedArtist} best ${seedLanguage}`,
            `${seedLanguage} super hit songs`,
        ];
        for (const q of queries) {
            const results = await searchJioSaavn(q, 8);
            const valid = results.filter((t) => !excludeIds.has(t.id) &&
                !excludeIds.has(t.streamUrl) &&
                (t.language === seedLanguage || seedLanguage === "global") &&
                t.title.toLowerCase() !== seedTitle.toLowerCase());
            if (valid.length > 0) {
                // Pick randomly from top 3 to keep discovery fresh
                return valid[Math.floor(Math.random() * Math.min(3, valid.length))];
            }
        }
    }
    catch { }
    return null;
}
/**
 * Resolves a JioSaavnTrack into a playable Lavalink Track across candidate nodes
 */
export async function loadJioSaavnAsLavalinkTrack(jioTrack, requester, candidateNodes) {
    if (!jioTrack?.streamUrl)
        return null;
    for (const node of candidateNodes) {
        if (!node || !node.connected)
            continue;
        try {
            const res = await node.search({ query: jioTrack.streamUrl }, requester);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                const trk = res.tracks[0];
                trk.info.title = jioTrack.title;
                trk.info.author = jioTrack.artist;
                trk.info.artworkUrl = jioTrack.artworkUrl;
                trk.info.uri = jioTrack.uri;
                trk.info.sourceName = "jiosaavn";
                trk.userData = {
                    ...(trk.userData || {}),
                    isJioSaavn: true,
                    quality: "320kbps",
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
