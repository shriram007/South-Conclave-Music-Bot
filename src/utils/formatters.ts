import { VoiceBasedChannel } from "discord.js";

/**
 * Format milliseconds into MM:SS or HH:MM:SS format
 */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0 || isNaN(ms)) return "0:00";
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

/**
 * Create a visual progress bar with filled bar, pointer, and playback state
 */
export function createProgressBar(
  currentMs: number,
  totalMs: number,
  barLength: number = 15,
  isPaused: boolean = false
): string {
  if (!totalMs || totalMs <= 0) {
    return `🔴 \`LIVE STREAM\` \`[${formatDuration(currentMs)}]\``;
  }

  const progress = Math.min(Math.max(currentMs / totalMs, 0), 1);
  const progressIndex = Math.min(Math.floor(progress * barLength), barLength - 1);

  let bar = "";
  for (let i = 0; i < barLength; i++) {
    if (i < progressIndex) {
      bar += "━";
    } else if (i === progressIndex) {
      bar += "🔘";
    } else {
      bar += "─";
    }
  }

  const statusIcon = isPaused ? "⏸️" : "▶️";
  return `${statusIcon} \`${formatDuration(currentMs)}\` \`${bar}\` \`${formatDuration(totalMs)}\``;
}

/**
 * Flavi-style clean progress slider (purple dot on sleek track with split timestamps)
 */
export function createFlaviProgressBar(
  currentMs: number,
  totalMs: number,
  barLength: number = 14
): string {
  if (!totalMs || totalMs <= 0) {
    return `🔴 \`LIVE STREAM\` \`[${formatDuration(currentMs)}]\``;
  }

  const progress = Math.min(Math.max(currentMs / totalMs, 0), 1);
  const progressIndex = Math.min(Math.floor(progress * barLength), barLength - 1);

  let bar = "";
  for (let i = 0; i < barLength; i++) {
    if (i === progressIndex) {
      bar += "🟣";
    } else if (i < progressIndex) {
      bar += "━";
    } else {
      bar += "─";
    }
  }

  const currentStr = formatDuration(currentMs);
  const totalStr = formatDuration(totalMs);

  return `\`${currentStr}\` ${bar} \`${totalStr}\``;
}


/**
 * Return friendly badges and bitrate descriptions for various audio sources
 */
export function getSourceInfo(sourceName?: string): { name: string; quality: string; badge: string; color: number } {
  const src = (sourceName || "").toLowerCase();

  switch (src) {
    case "jiosaavn":
      return {
        name: "JioSaavn Hi-Fi",
        quality: "320 kbps Studio Quality",
        badge: "💎 **JioSaavn Hi-Fi** `320 kbps HQ`",
        color: 0x2bc5b4,
      };
    case "deezer":
      return {
        name: "Deezer Hi-Fi",
        quality: "320 kbps MP3 / Lossless FLAC",
        badge: "💎 **Deezer Hi-Fi** `320 kbps / FLAC`",
        color: 0xef5466,
      };
    case "spotify":
      return {
        name: "Spotify",
        quality: "Hi-Fi Studio Match",
        badge: "🟢 **Spotify** `Hi-Fi Stream`",
        color: 0x1db954,
      };
    case "applemusic":
      return {
        name: "Apple Music",
        quality: "Apple Lossless Matched",
        badge: "🍎 **Apple Music** `HQ Stream`",
        color: 0xfc3c44,
      };
    case "youtubemusic":
      return {
        name: "YouTube Music",
        quality: "256 kbps AAC / Opus",
        badge: "🎧 **YouTube Music HQ** `256 kbps`",
        color: 0xff0000,
      };
    case "soundcloud":
      return {
        name: "SoundCloud",
        quality: "SoundCloud High Quality",
        badge: "🟠 **SoundCloud** `HQ Stream`",
        color: 0xff5500,
      };
    default:
      return {
        name: sourceName || "Direct Stream",
        quality: "High-Fidelity Opus",
        badge: `🎵 **${sourceName || "Standard"}** \`HQ Opus\``,
        color: 0x5865f2,
      };
  }
}

/**
 * Inspect voice channel bitrate status
 */
export function getChannelBitrateInfo(channel: VoiceBasedChannel): {
  bitrateKbps: number;
  tier: string;
  isMaxQuality: boolean;
  recommendation: string;
} {
  const bitrateKbps = Math.round(channel.bitrate / 1000);
  const tier = channel.guild.premiumTier;

  let maxPossible = 96;
  if (tier === 1) maxPossible = 128;
  if (tier === 2) maxPossible = 256;
  if (tier === 3) maxPossible = 384;

  const isMaxQuality = bitrateKbps >= maxPossible;
  let recommendation = "";

  if (bitrateKbps < 96) {
    recommendation = `⚠️ **Channel bitrate is set to ${bitrateKbps} kbps.** To get premium 300+ kbps sound, ask an admin to edit this Voice Channel and drag the **Bitrate slider to the maximum**!`;
  } else if (bitrateKbps < maxPossible) {
    recommendation = `ℹ️ This server has Boost Tier ${tier} (supports up to ${maxPossible} kbps). Increase this voice channel's bitrate slider to **${maxPossible} kbps** for maximum clarity.`;
  } else {
    recommendation = `✨ **Maximum channel fidelity enabled!** (${bitrateKbps} kbps Opus stream).`;
  }

  return {
    bitrateKbps,
    tier: `Tier ${tier}`,
    isMaxQuality,
    recommendation,
  };
}

/**
 * Calculates Levenshtein edit distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Normalized fuzzy similarity score between two words [0.0 - 1.0]
 */
export function calculateFuzzySimilarity(tokenA: string, tokenB: string): number {
  const maxLen = Math.max(tokenA.length, tokenB.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - levenshteinDistance(tokenA, tokenB) / maxLen;
}

/**
 * Computes relevance score between candidate track and target query [0.0 - 1.0]
 */
export function getTrackRelevanceScore(candidateTitle: string, targetTitle: string): number {
  if (!candidateTitle || !targetTitle) return 0;

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normTarget = normalize(targetTitle);
  const normCandidate = normalize(candidateTitle);

  if (normCandidate === normTarget) return 1.0;
  if (normCandidate.includes(normTarget)) return 0.95;

  const noise = new Set([
    "from", "song", "video", "official", "audio", "lyric", "lyrical",
    "full", "movie", "the", "and", "with", "track", "music", "original",
  ]);

  const targetTokens = normTarget.split(" ").filter((w) => w.length >= 3 && !noise.has(w));
  const candidateTokens = normCandidate.split(" ").filter((w) => w.length >= 3 && !noise.has(w));

  if (targetTokens.length === 0) {
    return normCandidate.includes(normTarget) ? 0.85 : 0;
  }

  let maxScore = 0;
  for (const tToken of targetTokens) {
    if (normCandidate.includes(tToken)) {
      maxScore = Math.max(maxScore, 0.85);
      continue;
    }
    for (const cToken of candidateTokens) {
      const sim = calculateFuzzySimilarity(tToken, cToken);
      if (sim > maxScore) maxScore = sim;
    }
  }

  return maxScore;
}

/**
 * Verifies that a search result or fallback candidate is genuinely relevant to the requested song.
 * Uses phonetic/fuzzy Levenshtein distance (e.g., handles typos like 'yarumula' -> 'yaarumilla').
 */
export function isRelevantTrack(candidateTitle: string, targetTitle: string, minSimilarity: number = 0.65): boolean {
  return getTrackRelevanceScore(candidateTitle, targetTitle) >= minSimilarity;
}

