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
export function getSourceInfo(sourceName?: string, uri?: string): { name: string; quality: string; badge: string; color: number } {
  const src = (sourceName || "").toLowerCase();
  const rawUri = (uri || "").toLowerCase();

  if (
    src === "jiosaavn" ||
    rawUri.includes("saavncdn.com") ||
    rawUri.includes("jiosaavn.com")
  ) {
    return {
      name: "JioSaavn Studio Master",
      quality: "320 kbps AAC Studio Audio",
      badge: "💎 **JioSaavn Studio** `320 kbps AAC`",
      color: 0x2bc5b4,
    };
  }

  switch (src) {
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

  // If target has only 1 meaningful token (e.g. "yaarumilla" or typo "yarumula")
  if (targetTokens.length === 1) {
    const tToken = targetTokens[0];
    if (normCandidate.includes(tToken)) return 0.90;
    let bestSim = 0;
    for (const cToken of candidateTokens) {
      const sim = calculateFuzzySimilarity(tToken, cToken);
      if (sim > bestSim) bestSim = sim;
    }
    return bestSim;
  }

  // Multi-token target: check if any hyphen-separated title segment is present (e.g. "Artist - Song Title")
  const rawParts = targetTitle.split(/[-–—|:]/);
  for (const part of rawParts) {
    const normPart = normalize(part);
    if (normPart.length >= 4 && normCandidate.includes(normPart)) {
      return 0.92;
    }
  }

  // For multi-token queries, calculate matching token ratio with fuzzy support
  let matchedTokens = 0;
  let totalScore = 0;

  for (const tToken of targetTokens) {
    let tokenBest = 0;
    if (normCandidate.includes(tToken)) {
      tokenBest = 1.0;
    } else {
      for (const cToken of candidateTokens) {
        const sim = calculateFuzzySimilarity(tToken, cToken);
        if (sim > tokenBest) tokenBest = sim;
      }
    }

    if (tokenBest >= 0.70) {
      matchedTokens++;
    }
    totalScore += tokenBest;
  }

  const matchRatio = matchedTokens / targetTokens.length;
  const avgScore = totalScore / targetTokens.length;

  return matchRatio >= 0.5 ? Math.max(avgScore, matchRatio * 0.9) : avgScore * 0.5;
}

/**
 * Verifies that a search result or fallback candidate is genuinely relevant to the requested song.
 * Uses phonetic/fuzzy Levenshtein distance (e.g., handles typos like 'yarumula' -> 'yaarumilla').
 */
export function isRelevantTrack(candidateTitle: string, targetTitle: string, minSimilarity: number = 0.65): boolean {
  return getTrackRelevanceScore(candidateTitle, targetTitle) >= minSimilarity;
}

export type MusicLanguage =
  | "tamil"
  | "telugu"
  | "malayalam"
  | "kannada"
  | "hindi"
  | "punjabi"
  | "korean"
  | "japanese"
  | "english"
  | "global";

/**
 * Detects the musical language / cultural context of a track using scripts, keywords, artist names, and record labels.
 */
export function detectTrackLanguage(title: string, author: string = ""): MusicLanguage {
  const text = `${title} ${author}`.toLowerCase();

  // 1. Unicode Script blocks (100% conclusive)
  if (/[\u0B80-\u0BFF]/.test(text)) return "tamil";
  if (/[\u0C00-\u0C7F]/.test(text)) return "telugu";
  if (/[\u0D00-\u0D7F]/.test(text)) return "malayalam";
  if (/[\u0C80-\u0CFF]/.test(text)) return "kannada";
  if (/[\u0900-\u097F]/.test(text)) return "hindi";
  if (/[\u0A00-\u0A7F]/.test(text)) return "punjabi";
  if (/[\uAC00-\uD7AF]/.test(text)) return "korean";
  if (/[\u3040-\u30ff]/.test(text)) return "japanese";

  // 2. Explicit Language tags in titles
  if (/\b(tamil|thamizh|thamizhan)\b/i.test(text)) return "tamil";
  if (/\b(telugu)\b/i.test(text)) return "telugu";
  if (/\b(malayalam)\b/i.test(text)) return "malayalam";
  if (/\b(kannada)\b/i.test(text)) return "kannada";
  if (/\b(hindi|bollywood)\b/i.test(text)) return "hindi";
  if (/\b(punjabi)\b/i.test(text)) return "punjabi";

  // 3. Indian Label Channel checks
  if (/\b(think music|sony music south|saregama tamil|lahari tamil|sun pictures|vijay music|trendmusic)\b/i.test(text)) return "tamil";
  if (/\b(aditya music|lahari telugu|saregama telugu|mango music)\b/i.test(text)) return "telugu";
  if (/\b(muzik247|saina music|millennium audios|satyam audios|manorama music)\b/i.test(text)) return "malayalam";
  if (/\b(anand audio|jhankar music|aakash audio)\b/i.test(text)) return "kannada";
  if (/\b(t-series|zeemusic|yrf|tips official|eros now|venus)\b/i.test(text)) return "hindi";
  if (/\b(speed records|white hill music|single track studios)\b/i.test(text)) return "punjabi";

  // 4. Prominent Artists, Composers, and Movie Keywords
  // Tamil
  if (/\b(anirudh|yuvan|ilayaraja|ilayaraaja|harris jayaraj|santhosh narayanan|sa-na|dhanush|vijay sethupathi|trisha|govind vasantha|sid sriram|u1|spb|karthik|chinmayi|naresh iyer|gv prakash|g\.v\. prakash|d imman|vijay|ajith|suriya|rajinikanth|kamal haasan|vignesh shivan|sean roldan|pradeep kumar|dhee|haricharan|shweta mohan|vijay antony|deva|vidyasagar|stephen zechariah|keba jeremiah|ar rahman|a\.r\. rahman|a\.r\.rahman|rahman|roja|bombay|kandukondain|alaipayuthey|uzhavan|vinnaithaandi|mudhalvan|sivaji|gentleman|kadhal|kadhale|kaathalae|kanne|kannamma|vaathi|mersal|leo|jailer|master|vikram|kaaviyathalaivan|aarambam|asuran|karnan|raayan|goat|anbe shivam|jeans|vinnai|munbe|vaarayo|idhazhin|mazhai|yennai|konjam|kadhal|sol|en kadhal|yen kadhal|thalli pogathey|neethanae|nenjukulle|kannaana|rowdy baby|chellamma|naanum rowdy|siennor|yosikadhey|nickila|kaber vasuki|paal dabba|sai abhyankkar|katchi sera|aasa kooda|kuthanthu|kavithai|varigal|isai|paadal|uyire|anbe|kanmani|vizhi|penne|nenje)\b/i.test(text)) {
    return "tamil";
  }

  // Telugu
  if (/\b(devi sri prasad|dsp|thaman|keeravani|m\.m\. keeravani|chiranjeevi|mahesh babu|allu arjun|prabhas|ntr|ram charan|anurag kulkarni|ramajogayya|nani|devara|pushpa|kalki|gopi sundar|mickey j meyer|hemanth|geetha madhuri|samajavaragamana|ala vaikunthapurramuloo|butta bomma|oo antava)\b/i.test(text)) {
    return "telugu";
  }

  // Malayalam
  if (/\b(sushin shyam|rex vijayan|shaan rahman|bijibal|mohanlal|mammootty|dulquer|fahadh|prithviraj|vineeth sreenivasan|ks chithra|chithra|jassie gift|job kurian|manjari|mg sreekumar|avesham|premalu|manjummel|hridayam|kumbalangi)\b/i.test(text)) {
    return "malayalam";
  }

  // Hindi
  if (/\b(arijit|pritam|atif aslam|neha kakkar|vishal-shekhar|shreya ghoshal|sonu nigam|jubin nautiyal|badshah|honey singh|armaan malik|darshan raval|amit trivedi|sachin-jigar|alka yagnik|udit narayan|kumar sanu|sunidhi chauhan|mohit chauhan|kk|rahat fateh|shankar-ehsaan-loy|khwaja|jodhaa|sufi|ghazal|qawwali|karan johar|shah rukh|salman|aamir|ranbir|ranveer|kesariya|channa mereya|tum hi ho|rang de basanti|luka chuppi)\b/i.test(text)) {
    return "hindi";
  }

  // Punjabi
  if (/\b(moosewala|sidhu|ap dhillon|diljit|karan aujla|shubh|gurdas|b praak|jassi|ammy virk|hardy sandhu|guru randhawa|sukhe|mankirt)\b/i.test(text)) {
    return "punjabi";
  }

  // Korean
  if (/\b(k-pop|kpop|bts|blackpink|stray kids|twice|newjeans|exo|iu|aespa|seventeen|red velvet|enhypen|tomorrow x together)\b/i.test(text)) {
    return "korean";
  }

  // Japanese
  if (/\b(anime|j-pop|jpop|yoasobi|kenshi yonezu|lisa|ado|eve|radwimps|aimer|official hige dandism|fujii kaze)\b/i.test(text)) {
    return "japanese";
  }

  // English / Western
  if (/\b(the weeknd|ed sheeran|taylor swift|drake|post malone|coldplay|billie eilish|dua lipa|eminem|bruno mars|ariana grande|travis scott|kendrick|justin bieber|imagine dragons|rihanna|maroon 5|charlie puth|adele|shawn mendes|olivia rodrigo)\b/i.test(text)) {
    return "english";
  }

  return "global";
}

/**
 * Checks if candidate track language is culturally and linguistically compatible with the seed track.
 * Strictly prevents cross-language jarring transitions (e.g. Tamil -> Hindi or Western -> Bollywood).
 */
export function isLanguageCompatible(seedLang: MusicLanguage, candidateLang: MusicLanguage): boolean {
  if (seedLang === "global" || candidateLang === "global") return true;
  if (seedLang === candidateLang) return true;

  const isSouthIndian = (l: MusicLanguage) => l === "tamil" || l === "telugu" || l === "malayalam" || l === "kannada";
  const isNorthIndian = (l: MusicLanguage) => l === "hindi" || l === "punjabi";

  // Strict boundary: South Indian vs North Indian vs Western
  if (isSouthIndian(seedLang) && isNorthIndian(candidateLang)) return false;
  if (isNorthIndian(seedLang) && isSouthIndian(candidateLang)) return false;
  if (seedLang === "english" && (isSouthIndian(candidateLang) || isNorthIndian(candidateLang))) return false;
  if ((isSouthIndian(seedLang) || isNorthIndian(seedLang)) && candidateLang === "english") return false;

  return false;
}


