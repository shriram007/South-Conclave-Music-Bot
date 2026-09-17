/**
 * Format milliseconds into MM:SS or HH:MM:SS format
 */
export function formatDuration(ms) {
    if (!ms || ms <= 0 || isNaN(ms))
        return "00:00";
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
    if (hours > 0) {
        return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }
    return `${pad(minutes)}:${pad(seconds)}`;
}
/**
 * Create a visual progress bar with filled bar, pointer, and playback state
 */
export function createProgressBar(currentMs, totalMs, barLength = 15, isPaused = false) {
    if (!totalMs || totalMs <= 0) {
        return `🔴 \`LIVE STREAM\` \`[${formatDuration(currentMs)}]\``;
    }
    const progress = Math.min(Math.max(currentMs / totalMs, 0), 1);
    const progressIndex = Math.min(Math.floor(progress * barLength), barLength - 1);
    let bar = "";
    for (let i = 0; i < barLength; i++) {
        if (i < progressIndex) {
            bar += "━";
        }
        else if (i === progressIndex) {
            bar += "🔘";
        }
        else {
            bar += "─";
        }
    }
    const statusIcon = isPaused ? "⏸️" : "▶️";
    return `${statusIcon} \`${formatDuration(currentMs)}\` \`${bar}\` \`${formatDuration(totalMs)}\``;
}
/**
 * Return friendly badges and bitrate descriptions for various audio sources
 */
export function getSourceInfo(sourceName) {
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
export function getChannelBitrateInfo(channel) {
    const bitrateKbps = Math.round(channel.bitrate / 1000);
    const tier = channel.guild.premiumTier;
    let maxPossible = 96;
    if (tier === 1)
        maxPossible = 128;
    if (tier === 2)
        maxPossible = 256;
    if (tier === 3)
        maxPossible = 384;
    const isMaxQuality = bitrateKbps >= maxPossible;
    let recommendation = "";
    if (bitrateKbps < 96) {
        recommendation = `⚠️ **Channel bitrate is set to ${bitrateKbps} kbps.** To get premium 300+ kbps sound, ask an admin to edit this Voice Channel and drag the **Bitrate slider to the maximum**!`;
    }
    else if (bitrateKbps < maxPossible) {
        recommendation = `ℹ️ This server has Boost Tier ${tier} (supports up to ${maxPossible} kbps). Increase this voice channel's bitrate slider to **${maxPossible} kbps** for maximum clarity.`;
    }
    else {
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
 * Verifies that a search result or fallback candidate is genuinely relevant to the requested song.
 * Prevents playing completely unrelated DJ sets, podcasts, or mixes.
 */
export function isRelevantTrack(candidateTitle, targetTitle) {
    if (!candidateTitle || !targetTitle)
        return false;
    const normalize = (s) => s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const normTarget = normalize(targetTitle);
    const normCandidate = normalize(candidateTitle);
    // Common noise words in titles
    const noise = new Set([
        "from", "song", "video", "official", "audio", "lyric", "lyrical",
        "full", "movie", "the", "and", "with", "track", "music", "original",
    ]);
    const targetTokens = normTarget.split(" ").filter((w) => w.length >= 3 && !noise.has(w));
    if (targetTokens.length === 0) {
        return normCandidate.includes(normTarget);
    }
    // The candidate must match at least one significant keyword (e.g. "kannamma")
    return targetTokens.some((token) => normCandidate.includes(token));
}
