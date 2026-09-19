import CryptoJS from "crypto-js";

export interface JioSaavnTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  duration: number; // in seconds
  artworkUrl: string;
  streamUrl: string; // Direct 320 kbps CDN audio link
  language: string;
  has320kbps: boolean;
  uri: string;
}

/**
 * Clean and decode HTML entities commonly returned by JioSaavn
 */
function cleanText(text: string): string {
  if (!text) return "";
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
export function decryptMediaUrl(encryptedUrl: string): string | null {
  if (!encryptedUrl) return null;
  try {
    const key = CryptoJS.enc.Utf8.parse("38346591");
    const decrypted = CryptoJS.DES.decrypt(encryptedUrl, key, {
      mode: CryptoJS.mode.ECB,
      padding: CryptoJS.pad.Pkcs7,
    });
    const rawUrl = decrypted.toString(CryptoJS.enc.Utf8);
    if (!rawUrl || !rawUrl.startsWith("http")) return null;

    // Direct 320 kbps upgrade
    return rawUrl.replace(/_96\.mp4|_160\.mp4/, "_320.mp4");
  } catch {
    return null;
  }
}

/**
 * Search JioSaavn for tracks matching the query
 */
export async function searchJioSaavn(query: string, limit: number = 5): Promise<JioSaavnTrack[]> {
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

    if (!res.ok) return [];
    const data: any = await res.json();
    const rawResults = data?.results || [];
    if (!Array.isArray(rawResults) || rawResults.length === 0) return [];

    const tracks: JioSaavnTrack[] = [];

    for (const item of rawResults) {
      const encUrl = item?.more_info?.encrypted_media_url || item?.encrypted_media_url || item?.encrypted_drm_media_url;
      const streamUrl = decryptMediaUrl(encUrl);
      if (!streamUrl) continue;

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
  } catch (err) {
    console.warn("[JioSaavn] Search exception:", err);
    return [];
  }
}

/**
 * Strips YouTube fluff (VEVO, record labels, channels, video/lyric tags) and extracts clean song & artist
 */
export function sanitizeMusicQuery(rawTitle: string, rawAuthor: string = ""): { searchTitle: string; searchArtist: string } {
  let cleanAuthor = (rawAuthor || "")
    .replace(/- Topic/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  // Strip labels, channels, VEVO
  if (/vevo|t-series|sony|zee|saregama|aditya|tips|channel|music|records|south|official/i.test(cleanAuthor)) {
    cleanAuthor = "";
  }

  let title = rawTitle
    .replace(/\|.*/, "") // Strip everything after first pipe "|"
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/official\s*(music)?\s*(video|audio|lyric|track)?/gi, "")
    .replace(/lyric(al)?\s*(video|song|audio)?/gi, "")
    .replace(/video\s*song/gi, "")
    .replace(/full\s*song/gi, "")
    .replace(/4k|8k|hd|hq|audio/gi, "")
    .trim();

  // If title has Movie - SongName or SongName - Artist
  if (title.includes(" - ")) {
    const parts = title.split(" - ").map((p) => p.trim());
    if (parts.length === 2) {
      return { searchTitle: parts[1], searchArtist: cleanAuthor || parts[0] };
    }
  }

  return { searchTitle: title, searchArtist: cleanAuthor };
}

/**
 * Checks whether a candidate title matches the target song name, accounting for typos and vowel doubling
 */
export function isFuzzyTitleMatch(titleA: string, titleB: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(titleA);
  const b = norm(titleB);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;

  // Squash consecutive repeated characters (e.g. "yaarumilla" -> "yarumila")
  const squash = (s: string) => s.replace(/(.)\1+/g, "$1");
  const sa = squash(a);
  const sb = squash(b);
  if (sa.includes(sb) || sb.includes(sa)) return true;

  // Substring / character overlap ratio for phonetic spelling differences
  let matchCount = 0;
  for (const ch of b) {
    if (a.includes(ch)) matchCount++;
  }
  return matchCount / Math.max(a.length, b.length) >= 0.75;
}

/**
 * Auto-corrects typos in song queries using real-time search suggestion signals
 */
export async function getSpellingSuggestion(query: string): Promise<string | null> {
  const cleanQ = query.replace(/\|.*/, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
  if (!cleanQ || cleanQ.length < 3) return null;

  const candidates = [cleanQ, `${cleanQ} song`];
  for (const q of candidates) {
    try {
      const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) continue;
      const data: any = await res.json();
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
    } catch {}
  }
  return null;
}

/**
 * Resolves a single best matching track from JioSaavn for a given song title and artist with typo correction
 */
export async function resolveJioSaavnTrack(title: string, artist: string = ""): Promise<JioSaavnTrack | null> {
  const { searchTitle, searchArtist } = sanitizeMusicQuery(title, artist);
  const targetSongName = searchTitle || title;

  const query = `${searchTitle} ${searchArtist}`.trim();
  let results = await searchJioSaavn(query, 5);

  // 1. Check if any result matches the target song name
  let best = results.find((t) => isFuzzyTitleMatch(t.title, targetSongName));

  // 2. If no match and artist was supplied, try searching title alone (prevents channel/movie name collision)
  if (!best && searchArtist) {
    const soloResults = await searchJioSaavn(searchTitle, 5);
    best = soloResults.find((t) => isFuzzyTitleMatch(t.title, targetSongName));
    if (best) results = soloResults;
  }

  // 3. If still no match, attempt typo auto-correction
  if (!best) {
    const suggestion = (await getSpellingSuggestion(query)) || (await getSpellingSuggestion(searchTitle));
    if (suggestion) {
      console.log(`[JioSaavn Resolver] Typo detected in "${query}". Auto-correcting to "${suggestion}"...`);
      const correctedResults = await searchJioSaavn(suggestion, 5);
      best = correctedResults.find(
        (t) => isFuzzyTitleMatch(t.title, suggestion) || isFuzzyTitleMatch(t.title, targetSongName)
      );
    }
  }

  // STRICT: NEVER return results[0] unless it actually matches!
  return best || null;
}

/**
 * Generates an autoplay recommendation using JioSaavn's catalog in the exact same language and vibe
 */
export async function findJioSaavnAutoplay(seedTitle: string, seedArtist: string, seedLanguage: string = "tamil", excludeIds: Set<string> = new Set()): Promise<JioSaavnTrack | null> {
  try {
    const queries = [
      `${seedArtist} ${seedLanguage} hits`,
      `${seedTitle} ${seedLanguage} radio`,
      `${seedArtist} best ${seedLanguage}`,
      `${seedLanguage} super hit songs`,
    ];

    for (const q of queries) {
      const results = await searchJioSaavn(q, 8);
      const valid = results.filter(
        (t) =>
          !excludeIds.has(t.id) &&
          !excludeIds.has(t.streamUrl) &&
          (t.language === seedLanguage || seedLanguage === "global") &&
          t.title.toLowerCase() !== seedTitle.toLowerCase()
      );

      if (valid.length > 0) {
        // Pick randomly from top 3 to keep discovery fresh
        return valid[Math.floor(Math.random() * Math.min(3, valid.length))];
      }
    }
  } catch {}

  return null;
}

/**
 * Resolves a JioSaavnTrack into a playable Lavalink Track across candidate nodes
 */
export async function loadJioSaavnAsLavalinkTrack(
  jioTrack: JioSaavnTrack,
  requester: any,
  candidateNodes: any[]
): Promise<{ track: any; node: any } | null> {
  if (!jioTrack?.streamUrl) return null;

  for (const node of candidateNodes) {
    if (!node || !node.connected) continue;
    try {
      const res: any = await node.search({ query: jioTrack.streamUrl }, requester);
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
    } catch {
      // Continue to next candidate node
    }
  }
  return null;
}
