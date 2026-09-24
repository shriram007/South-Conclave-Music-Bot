export function isSpotifyUrl(url) {
    if (!url || typeof url !== "string")
        return false;
    return (/^(?:https?:\/\/)?open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/i.test(url.trim()) ||
        /^spotify:(track|playlist|album):([a-zA-Z0-9]+)/i.test(url.trim()));
}
export function isSpotifyPlaylistOrAlbum(url) {
    if (!url || typeof url !== "string")
        return false;
    return (/^(?:https?:\/\/)?open\.spotify\.com\/(playlist|album)\/([a-zA-Z0-9]+)/i.test(url.trim()) ||
        /^spotify:(playlist|album):([a-zA-Z0-9]+)/i.test(url.trim()));
}
export function isSpotifyTrackUrl(url) {
    if (!url || typeof url !== "string")
        return false;
    return (/^(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)/i.test(url.trim()) ||
        /^spotify:track:([a-zA-Z0-9]+)/i.test(url.trim()));
}
/**
 * Resolves a Spotify track URL to a searchable track name + artist string
 */
export async function resolveSpotifyTrack(url) {
    const cleanUrl = url.split("?")[0].trim();
    try {
        // 1. Try HTML scraping
        const resp = await fetch(cleanUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            signal: AbortSignal.timeout(4000),
        });
        if (resp.ok) {
            const html = await resp.text();
            const match = html.match(/<title>(.*?) - song (?:and lyrics )?by (.*?) \| Spotify<\/title>/i);
            if (match && match[1] && match[2]) {
                console.log(`[Spotify Resolver] Resolved "${cleanUrl}" -> "${match[1]} ${match[2]}"`);
                return `${match[1]} ${match[2]}`.trim();
            }
        }
        // 2. Try oEmbed
        const oembedResp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`, {
            signal: AbortSignal.timeout(4000),
        });
        if (oembedResp.ok) {
            const data = (await oembedResp.json());
            if (data.title) {
                return `${data.title} ${data.author_name || ""}`.trim();
            }
        }
    }
    catch (e) {
        console.warn("[Spotify Resolver] Error resolving track:", e);
    }
    return null;
}
/**
 * Resolves a Spotify playlist or album URL into an array of tracks
 */
export async function resolveSpotifyCollection(url) {
    const trimmed = url.trim();
    const match = trimmed.match(/(?:open\.spotify\.com\/(playlist|album)\/|spotify:(playlist|album):)([a-zA-Z0-9]+)/i);
    if (!match)
        return null;
    const type = (match[1] || match[2]).toLowerCase();
    const id = match[3];
    const embedUrl = `https://open.spotify.com/embed/${type}/${id}`;
    try {
        const res = await fetch(embedUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
            const html = await res.text();
            const dataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (dataMatch) {
                const json = JSON.parse(dataMatch[1]);
                const entity = json.props?.pageProps?.state?.data?.entity;
                if (entity && Array.isArray(entity.trackList)) {
                    const title = entity.name || entity.title || (type === "album" ? "Spotify Album" : "Spotify Playlist");
                    const thumbnail = entity.coverArt?.sources?.[0]?.url;
                    const tracks = entity.trackList
                        .filter((t) => t && (t.title || t.name))
                        .map((t) => ({
                        title: t.title || t.name,
                        artist: t.subtitle || t.artists?.[0]?.name || "",
                        duration: typeof t.duration === "number" ? t.duration : 0,
                        uri: t.uri,
                    }));
                    if (tracks.length > 0) {
                        console.log(`[Spotify Resolver] Loaded Spotify ${type} "${title}" with ${tracks.length} tracks.`);
                        return {
                            type,
                            title,
                            thumbnail,
                            tracks,
                        };
                    }
                }
            }
        }
    }
    catch (err) {
        console.warn(`[Spotify Resolver] Error loading Spotify ${type} from embed:`, err?.message || err);
    }
    return null;
}
