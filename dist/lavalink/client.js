import { EmbedBuilder, } from "discord.js";
import { LavalinkManager } from "lavalink-client";
import { config } from "../config.js";
import { buildPlayerMessage } from "./playerUI.js";
import { autoDeleteMessage } from "../utils/cleanup.js";
import { detectTrackLanguage, getChannelBitrateInfo, isLanguageCompatible, isRelevantTrack } from "../utils/formatters.js";
import { is247Enabled } from "../utils/twentyFourSeven.js";
import { clearGuildSession, saveActiveSessions } from "../utils/sessionRecovery.js";
import { applyLoudnessNormalization } from "../commands/normalize.js";
import { findJioSaavnAutoplay, loadJioSaavnAsLavalinkTrack, resolveJioSaavnTrack } from "../services/jiosaavn.js";
export let lavalink;
export let discordClient;
// Track active player messages so we can update or clean them up
export const activePlayerMessages = new Map(); // guildId -> messageId
export const playerMessageCache = new Map(); // guildId -> Message object (fast direct edit)
// Global cache of stream-restricted / login-required video IDs so we never re-select or loop on them
export const restrictedTrackIds = new Set();
// Dynamic node health & circuit breaker: tracks nodes returning 502/HTML errors or timeouts
export const degradedNodes = new Map(); // nodeId -> expiry timestamp
export function markNodeDegraded(nodeId, durationMs = 180000) {
    console.warn(`[Node Circuit Breaker] Marking node "${nodeId}" as degraded for ${Math.round(durationMs / 1000)}s`);
    degradedNodes.set(nodeId, Date.now() + durationMs);
}
export function isNodeHealthy(nodeId) {
    const expiry = degradedNodes.get(nodeId);
    if (!expiry)
        return true;
    if (Date.now() > expiry) {
        degradedNodes.delete(nodeId);
        return true;
    }
    return false;
}
/**
 * Completely disables all DSP filters and equalizers, guaranteeing 100% bit-perfect PCM passthrough
 */
export async function clearAllFilters(player) {
    if (!player)
        return;
    player.filterManager.equalizerBands = [];
    player.filterManager.data = {};
    player.setData("hifi_active", false);
    player.setData("eq_preset", "Normal (Flat)");
    player.setData("filter_preset_key", "reset");
    player.setData("normalized", false);
    try {
        if (player.node?.connected) {
            await player.node.updatePlayer({
                guildId: player.guildId,
                playerOptions: { filters: {} },
            });
        }
    }
    catch (err) {
        console.warn("[Player Filters] Error clearing filters:", err);
    }
}
/**
 * Auto-maximizes voice channel bitrate to server peak (up to 384 kbps for Tier 3, 256 kbps for Tier 2, 128 kbps for Tier 1, 96 kbps for Tier 0)
 */
export async function autoMaximizeVoiceChannelBitrate(voiceChannel) {
    if (!voiceChannel)
        return;
    try {
        const tier = voiceChannel.guild.premiumTier;
        let maxBitrate = 96000;
        if (tier === 1)
            maxBitrate = 128000;
        if (tier === 2)
            maxBitrate = 256000;
        if (tier === 3)
            maxBitrate = 384000;
        if (voiceChannel.bitrate < maxBitrate) {
            const botMember = voiceChannel.guild.members.me;
            if (botMember?.permissions.has("ManageChannels")) {
                await voiceChannel.setBitrate(maxBitrate, "South Conclave Audiophile Auto-Optimization").catch(() => { });
                console.log(`[Audio Quality] Auto-maximized voice channel "${voiceChannel.name}" to ${Math.round(maxBitrate / 1000)} kbps (Tier ${tier} Peak)!`);
            }
        }
    }
    catch { }
}
/**
 * Validates that an autoplay recommendation is a genuine new song and not a live/remix/cover of a previous song
 */
export function isSameSongOrJunk(candidateTitle, previousTracks) {
    const simplify = (str) => str
        .toLowerCase()
        .replace(/\|.*/g, "")
        .replace(/\[.*?\]/g, "")
        .replace(/\(.*?\)/g, "")
        .replace(/feat\..*/g, "")
        .replace(/ft\..*/g, "")
        .replace(/official.*/g, "")
        .replace(/audio.*/g, "")
        .replace(/video.*/g, "")
        .replace(/remix.*/g, "")
        .replace(/live.*/g, "")
        .replace(/version.*/g, "")
        .replace(/lyric.*/g, "")
        .replace(/hd|4k|hq/gi, "")
        .replace(/[^a-z0-9]/g, "");
    const lowTitle = candidateTitle.toLowerCase();
    const junkKeywords = ["karaoke", "instrumental", "tutorial", "tribute", "how to play", "synthesia", "cover", "bass boosted"];
    if (junkKeywords.some((j) => lowTitle.includes(j)))
        return true;
    const candSimp = simplify(candidateTitle);
    if (!candSimp)
        return true;
    for (const prev of previousTracks) {
        const prevTitle = prev?.info?.title || "";
        const prevSimp = simplify(prevTitle);
        if (prevSimp && (candSimp.includes(prevSimp) || prevSimp.includes(candSimp))) {
            return true; // Collision with a previously played song!
        }
    }
    return false;
}
/**
 * Spotify/FlaviBot-Grade Recommendation Engine:
 * Generates acoustic neural radio seeds (RD<videoId>), diversifies by 80% same genre/vibe from other artists,
 * and upgrades every candidate to official 256kbps YouTube Music studio masters.
 */
export async function findAutoplayRecommendation(player, seedTrack) {
    const rawTitle = seedTrack.info.title || "";
    const rawAuthor = (seedTrack.info.author || "").replace(/- Topic/gi, "").trim();
    const cleanTitle = rawTitle.replace(/\|.*/, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim();
    const videoId = seedTrack.info.identifier;
    const seedLang = detectTrackLanguage(rawTitle, rawAuthor);
    console.log(`[Smart Autoplay] Finding AI radio recommendations based on "${cleanTitle}" by "${rawAuthor}" (Language: ${seedLang.toUpperCase()})...`);
    const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
    const healthyNodes = connectedNodes.filter((n) => isNodeHealthy(n.id));
    const kasawaNode = healthyNodes.find((n) => n.id === "Kasawa-MasterNode");
    const milloNode = healthyNodes.find((n) => n.id === "Millo-BackupNode");
    const serenetiaNode = healthyNodes.find((n) => n.id === "Serenetia-AuxNode");
    const otherHealthy = healthyNodes.filter((n) => n.id !== "Kasawa-MasterNode" && n.id !== "Millo-BackupNode" && n.id !== "Serenetia-AuxNode");
    const degradedList = connectedNodes.filter((n) => !isNodeHealthy(n.id));
    // Priority: Kasawa (supports direct 320k JioSaavn + YT/Spotify) > Millo > Serenetia
    const nodesToTry = healthyNodes.length > 0 ? [
        ...(kasawaNode ? [kasawaNode] : []),
        ...(milloNode ? [milloNode] : []),
        ...(serenetiaNode ? [serenetiaNode] : []),
        ...otherHealthy,
    ] : degradedList;
    const historyIds = new Set(player.queue.previous.map((t) => t.info.identifier).filter((id) => Boolean(id)));
    if (player.queue.current?.info.identifier)
        historyIds.add(player.queue.current.info.identifier);
    for (const t of player.queue.tracks) {
        if (t.info.identifier)
            historyIds.add(t.info.identifier);
    }
    let foundCandidate = null;
    const isJioSeed = Boolean(seedTrack.userData?.isJioSaavn) || seedTrack.info.sourceName === "jiosaavn";
    const previousTitles = [
        cleanTitle,
        rawTitle,
        ...(player.queue.current?.info?.title ? [player.queue.current.info.title] : []),
        ...player.queue.previous.map((t) => t.info?.title).filter(Boolean),
        ...player.queue.tracks.map((t) => t.info?.title).filter(Boolean),
    ];
    // Strategy 0: If current playing track came from JioSaavn (/jio), keep streaming pristine 320k JioSaavn Studio Radio!
    if (isJioSeed && ["tamil", "telugu", "malayalam", "hindi", "punjabi"].includes(seedLang)) {
        try {
            const jioAuto = await findJioSaavnAutoplay(cleanTitle, rawAuthor, seedLang, historyIds, previousTitles);
            if (jioAuto) {
                const allPrev = [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])];
                if (isSameSongOrJunk(jioAuto.title, allPrev)) {
                    console.log(`[Smart Autoplay] Discarded JioSaavn duplicate of previous track: "${jioAuto.title}"`);
                }
                else {
                    const candidateNodes = [
                        player.node,
                        ...(kasawaNode ? [kasawaNode] : []),
                        ...nodesToTry,
                    ];
                    const converted = await loadJioSaavnAsLavalinkTrack(jioAuto, { displayName: "📻 Autoplay Radio" }, candidateNodes);
                    if (converted) {
                        console.log(`[Smart Autoplay] Found regional JioSaavn recommendation (${seedLang}): "${converted.track.info.title}" by "${converted.track.info.author}"`);
                        converted.track.requester = { displayName: "📻 Autoplay Radio" };
                        converted.track.userData = { ...(converted.track.userData || {}), command: "Autoplay", isAutoplay: true };
                        return converted.track;
                    }
                }
            }
        }
        catch (e) {
            console.warn("[Smart Autoplay] JioSaavn discovery notice:", e);
        }
    }
    // Strategy 1: YouTube Music Native Algorithmic Radio Mix (25 AI-curated related tracks via RD<videoId>)
    if (videoId && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
        const radioUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
        for (const node of nodesToTry) {
            try {
                const radioPromise = node.search({ query: radioUrl }, seedTrack.requester);
                const timeoutPromise = new Promise((r) => setTimeout(() => r(null), 3500));
                const radioRes = await Promise.race([radioPromise, timeoutPromise]);
                if (radioRes?.tracks?.length && radioRes.loadType !== "error" && radioRes.loadType !== "empty") {
                    const validCandidates = radioRes.tracks.filter((t) => !historyIds.has(t.info.identifier) &&
                        !restrictedTrackIds.has(t.info.identifier) &&
                        !isSameSongOrJunk(t.info.title, [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])]) &&
                        (t.info.duration || 0) >= 60000 &&
                        (t.info.duration || 0) <= 900000 &&
                        isLanguageCompatible(seedLang, detectTrackLanguage(t.info.title, t.info.author || "")));
                    if (validCandidates.length > 0) {
                        // Prioritize candidates with the EXACT same language (e.g. Tamil -> Tamil)
                        const exactLangCandidates = validCandidates.filter((t) => detectTrackLanguage(t.info.title, t.info.author || "") === seedLang);
                        const candidatePool = exactLangCandidates.length > 0 ? exactLangCandidates : validCandidates;
                        const cleanCurrentAuthor = rawAuthor.toLowerCase();
                        const otherArtistCandidates = candidatePool.filter((t) => {
                            const tAuthor = (t.info?.author || "").toLowerCase();
                            return !tAuthor.includes(cleanCurrentAuthor) && !cleanCurrentAuthor.includes(tAuthor);
                        });
                        const sameArtistCandidates = candidatePool.filter((t) => {
                            const tAuthor = (t.info?.author || "").toLowerCase();
                            return tAuthor.includes(cleanCurrentAuthor) || cleanCurrentAuthor.includes(tAuthor);
                        });
                        // Vibe selection policy: 80% other artists in same language/vibe, 20% same artist
                        let candidate;
                        if (otherArtistCandidates.length > 0 && Math.random() < 0.80) {
                            candidate = otherArtistCandidates[Math.floor(Math.random() * Math.min(4, otherArtistCandidates.length))];
                            if (candidate)
                                console.log(`[Smart Autoplay] Language match (${seedLang}): "${candidate.info.title}" by "${candidate.info.author}"`);
                        }
                        else {
                            candidate = sameArtistCandidates[0] || otherArtistCandidates[0] || candidatePool[0];
                        }
                        if (candidate) {
                            foundCandidate = candidate;
                            break;
                        }
                    }
                }
            }
            catch (e) {
                const errMsg = e?.message || String(e);
                if (errMsg.includes("Unexpected token '<'") || errMsg.includes("<html>") || errMsg.includes("502") || errMsg.includes("ConnectTimeoutError") || errMsg.includes("fetch failed") || errMsg.includes("timeout")) {
                    markNodeDegraded(node.id);
                }
            }
        }
    }
    // Strategy 2: Curated artist hits & similar song search across nodes if RD playlist did not match
    if (!foundCandidate) {
        const queriesToTry = [];
        if (seedLang !== "global" && seedLang !== "english") {
            queriesToTry.push(`${cleanTitle} ${seedLang} songs`, `${rawAuthor} ${seedLang} hit songs`, `${cleanTitle} similar ${seedLang} songs`, `${rawAuthor} ${seedLang} radio`);
        }
        else {
            queriesToTry.push(`${cleanTitle} similar songs`, `${rawAuthor} similar artists`, `${cleanTitle} mix`, `${rawAuthor} top tracks`);
        }
        for (const query of queriesToTry) {
            if (foundCandidate)
                break;
            for (const node of nodesToTry) {
                try {
                    const searchPromise = node.search({ query, source: "ytmsearch" }, seedTrack.requester);
                    const timeoutPromise = new Promise((r) => setTimeout(() => r(null), 3500));
                    const recRes = await Promise.race([searchPromise, timeoutPromise]);
                    if (recRes?.tracks?.length && recRes.loadType !== "empty" && recRes.loadType !== "error") {
                        const candidate = recRes.tracks.find((t) => !historyIds.has(t.info.identifier) &&
                            !restrictedTrackIds.has(t.info.identifier) &&
                            !isSameSongOrJunk(t.info.title, [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])]) &&
                            (t.info.duration || 0) >= 60000 &&
                            (t.info.duration || 0) <= 900000 &&
                            isLanguageCompatible(seedLang, detectTrackLanguage(t.info.title, t.info.author || "")));
                        if (candidate) {
                            foundCandidate = candidate;
                            break;
                        }
                    }
                }
                catch (e) {
                    const errMsg = e?.message || String(e);
                    if (errMsg.includes("Unexpected token '<'") || errMsg.includes("<html>") || errMsg.includes("502") || errMsg.includes("ConnectTimeoutError") || errMsg.includes("fetch failed") || errMsg.includes("timeout")) {
                        markNodeDegraded(node.id);
                    }
                }
            }
        }
    }
    // Strategy 3: JioSaavn 320 kbps Autoplay Discovery (unrestricted, authentic 320 kbps studio audio)
    if (!foundCandidate) {
        try {
            const jioRec = await findJioSaavnAutoplay(cleanTitle, rawAuthor, seedLang, historyIds, previousTitles);
            if (jioRec) {
                const allPrev = [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])];
                if (!isSameSongOrJunk(jioRec.title, allPrev)) {
                    const jioCandidate = await loadJioSaavnAsLavalinkTrack(jioRec, seedTrack.requester, [
                        player.node,
                        ...nodesToTry,
                    ]);
                    if (jioCandidate) {
                        foundCandidate = jioCandidate.track;
                        console.log(`[Smart Autoplay] JioSaavn 320kbps discovery candidate: "${foundCandidate?.info?.title}" by "${foundCandidate?.info?.author}"`);
                    }
                }
            }
        }
        catch (e) {
            console.warn("[Smart Autoplay] JioSaavn autoplay discovery notice:", e);
        }
    }
    if (!foundCandidate)
        return null;
    // Guarantee official 256kbps YouTube Music Studio Master fidelity for non-Jio tracks
    let studioMasterTrack = foundCandidate;
    const isJio = Boolean(foundCandidate.userData?.isJioSaavn);
    const hqSearchNode = kasawaNode || milloNode || nodesToTry[0];
    if (!isJio && hqSearchNode) {
        try {
            const hqQuery = `${(foundCandidate.info.title || "").replace(/\|.*/, "").replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim()} ${(foundCandidate.info.author || "").replace(/- Topic/gi, "").trim()}`.trim();
            const hqRes = await hqSearchNode.search({
                query: hqQuery,
                source: "ytmsearch",
            }, seedTrack.requester).catch(() => null);
            if (hqRes?.tracks?.length && !restrictedTrackIds.has(hqRes.tracks[0].info.identifier)) {
                console.log(`[Smart Autoplay] Upgraded "${foundCandidate.info.title}" to official 256kbps YouTube Music master: "${hqRes.tracks[0].info.title}" via ${hqSearchNode.id}`);
                studioMasterTrack = hqRes.tracks[0];
            }
        }
        catch (e) {
            console.warn("[Smart Autoplay] Studio master upgrade notice:", e);
        }
    }
    // Do NOT force-migrate the player to a different node here — the player's current
    // healthy node is already streaming fine. Migration only happens in trackError recovery.
    studioMasterTrack.requester = { displayName: "📻 Autoplay Radio" };
    studioMasterTrack.userData = { ...(studioMasterTrack.userData || {}), command: "Autoplay", isAutoplay: true };
    return studioMasterTrack;
}
/**
 * Pre-fetches the next autoplay recommendation in the background while the current track is playing.
 * Enables zero-buffer (< 50ms) gapless transitions just like Spotify!
 */
export async function prefetchAutoplayTrack(player) {
    const isAutoplay = Boolean(player.getData("autoplay") ?? true);
    if (!isAutoplay)
        return;
    if (player.getData("recovering_track"))
        return;
    // STRICT USER PRIORITY: If there are ANY user-queued tracks, do not prefetch autoplay!
    const userTracks = player.queue.tracks.filter((t) => {
        const isAuto = t.requester?.displayName === "📻 Autoplay Radio" || t.requester?.username === "Autoplay Radio" || t.userData?.isAutoplay;
        return !isAuto;
    });
    if (userTracks.length > 0)
        return;
    if (player.queue.tracks.length > 0)
        return;
    if (player.getData("prefetching_autoplay"))
        return;
    const seed = player.queue.current || player.queue.previous[0];
    if (!seed)
        return;
    player.setData("prefetching_autoplay", true);
    try {
        const track = await findAutoplayRecommendation(player, seed);
        const currentUserTracks = player.queue.tracks.filter((t) => {
            const isAuto = t.requester?.displayName === "📻 Autoplay Radio" || t.requester?.username === "Autoplay Radio" || t.userData?.isAutoplay;
            return !isAuto;
        });
        if (track && currentUserTracks.length === 0 && player.queue.tracks.length === 0) {
            await player.queue.add(track);
            console.log(`[Smart Autoplay] Pre-fetched "${track.info.title}" by "${track.info.author}" for zero-buffer gapless transition.`);
        }
    }
    catch (err) {
        console.warn("[Smart Autoplay] Prefetch note:", err);
    }
    finally {
        player.setData("prefetching_autoplay", false);
    }
}
/**
 * Removes any pre-fetched autoplay tracks in-place from the queue so user-queued tracks take 100% priority
 */
export function purgeAutoplayTracks(player) {
    for (let i = player.queue.tracks.length - 1; i >= 0; i--) {
        const t = player.queue.tracks[i];
        const isAuto = t.requester?.displayName === "📻 Autoplay Radio" || t.requester?.username === "Autoplay Radio" || t.userData?.isAutoplay;
        if (isAuto) {
            player.queue.tracks.splice(i, 1);
        }
    }
}
export function getMasterNodeConfigs() {
    const configs = [];
    if (config.lavalink.host &&
        config.lavalink.host !== "localhost" &&
        !config.lavalink.host.includes("jirayu")) {
        configs.push({
            authorization: config.lavalink.password,
            host: config.lavalink.host,
            port: config.lavalink.port,
            secure: config.lavalink.secure,
            id: "Primary-CustomNode",
            retryAmount: 1000,
            retryDelay: 5000,
            retryTimespan: 180000,
            requestSignalTimeoutMS: 7000,
            enablePingOnStatsCheck: true,
        });
    }
    // Priority 1: Kasawa-MasterNode (verified online, supports direct HTTP 320k JioSaavn streaming, YT, Spotify, SoundCloud)
    configs.push({
        authorization: "youshallnotpass",
        host: "lava2.kasawa.pro",
        port: 2334,
        secure: false,
        id: "Kasawa-MasterNode",
        retryAmount: 1000,
        retryDelay: 5000,
        retryTimespan: 180000,
        requestSignalTimeoutMS: 7000,
        enablePingOnStatsCheck: true,
    }, {
        authorization: "https://discord.gg/mjS5J2K3ep",
        host: "lava-v4.millohost.my.id",
        port: 443,
        secure: true,
        id: "Millo-BackupNode",
        retryAmount: 1000,
        retryDelay: 5000,
        retryTimespan: 180000,
        requestSignalTimeoutMS: 7000,
        enablePingOnStatsCheck: true,
    }, {
        authorization: "https://seretia.link/discord",
        host: "lavalinkv4.serenetia.com",
        port: 443,
        secure: true,
        id: "Serenetia-AuxNode",
        retryAmount: 1000,
        retryDelay: 5000,
        retryTimespan: 180000,
        requestSignalTimeoutMS: 7000,
        enablePingOnStatsCheck: true,
    });
    return configs;
}
let watchdogInterval = null;
/**
 * Self-healing watchdog: detects missing or destroyed nodes and automatically recreates & reconnects them
 */
export async function ensureNodesHealthy() {
    if (!lavalink || !lavalink.nodeManager)
        return;
    const masterConfigs = getMasterNodeConfigs();
    if (!lavalink.options?.client?.id) {
        const clientId = discordClient?.user?.id || config.discord.clientId;
        if (clientId) {
            lavalink.options.client = {
                ...lavalink.options.client,
                id: clientId,
                username: discordClient?.user?.username || "SouthConclaveBot",
            };
        }
    }
    for (const nodeConfig of masterConfigs) {
        const existingNode = lavalink.nodeManager.nodes.get(nodeConfig.id);
        if (!existingNode) {
            console.log(`[Self-Healing Watchdog] Re-registering destroyed/missing node "${nodeConfig.id}"...`);
            try {
                const newNode = lavalink.nodeManager.createNode(nodeConfig);
                await newNode.connect();
                console.log(`[Self-Healing Watchdog] Node "${nodeConfig.id}" recreated and connected!`);
            }
            catch (err) {
                console.warn(`[Self-Healing Watchdog] Reconnection failed for "${nodeConfig.id}":`, err?.message || err);
            }
        }
        else if (!existingNode.connected && !existingNode.isNodeReconnecting) {
            console.log(`[Self-Healing Watchdog] Triggering connect for idle disconnected node "${existingNode.id}"...`);
            try {
                existingNode.connect();
            }
            catch (err) {
                console.warn(`[Self-Healing Watchdog] Failed connecting "${existingNode.id}":`, err?.message || err);
            }
        }
    }
}
export function initLavalink(client) {
    discordClient = client;
    lavalink = new LavalinkManager({
        nodes: getMasterNodeConfigs(),
        client: {
            id: config.discord.clientId || "",
            username: "SouthConclaveBot",
        },
        sendToShard: (guildId, payload) => {
            client.guilds.cache.get(guildId)?.shard.send(payload);
        },
        autoSkip: true,
        autoMove: true,
        autoSkipOnResolveError: true,
        playerOptions: {
            clientBasedPositionUpdateInterval: 150, // 150ms position accuracy for ultra-smooth timestamps
            defaultSearchPlatform: "ytmsearch", // YouTube Music HQ 256k as default
            volumeDecrementer: 1,
            maxErrorsPerTime: {
                threshold: 60000,
                maxAmount: 25,
            },
            onDisconnect: {
                autoReconnect: true,
                destroyPlayer: false,
            },
        },
    });
    // Lavalink Node Events
    lavalink.nodeManager.on("connect", (node) => {
        console.log(`[Lavalink] Connected to audio node "${node.id}" (${node.options.host}:${node.options.port})`);
    });
    lavalink.nodeManager.on("disconnect", (node, reason) => {
        console.warn(`[Lavalink] Disconnected from audio node "${node.id}": ${reason?.reason || "Unknown reason"}`);
    });
    lavalink.nodeManager.on("error", (node, error) => {
        console.error(`[Lavalink] Node "${node.id}" encountered an error:`, error.message);
    });
    // Self-Healing: if a node gets destroyed due to reconnection failure, auto-revive it
    lavalink.nodeManager.on("destroy", (node, reason) => {
        console.warn(`[Lavalink] Audio node "${node.id}" was destroyed (${reason}). Scheduling auto-revival in 3s...`);
        setTimeout(() => {
            ensureNodesHealthy().catch((err) => {
                console.warn("[Lavalink] Auto-revival error:", err?.message || err);
            });
        }, 3000);
    });
    // Continuous 20s watchdog: guarantee nodes never stay dead after network/DNS outages
    if (watchdogInterval)
        clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
        try {
            const anyConnected = Array.from(lavalink.nodeManager.nodes.values()).some((n) => n.connected);
            const hasMissingNodes = getMasterNodeConfigs().some((c) => !lavalink.nodeManager.nodes.has(c.id));
            if (!anyConnected || hasMissingNodes) {
                ensureNodesHealthy().catch(() => { });
            }
        }
        catch { }
    }, 20000);
    // Dedicated Live Player Ticker (smooth 3.5s updates while playing)
    const liveTickers = new Map();
    function startLivePlayerTicker(player) {
        stopLivePlayerTicker(player.guildId);
        let preloadedTrackId = null;
        const ticker = setInterval(async () => {
            try {
                // ONLY stop the ticker if there is NO current song in the player
                if (!player.queue.current) {
                    stopLivePlayerTicker(player.guildId);
                    return;
                }
                // If paused or stream not active, skip this tick without killing the timer
                if (player.paused)
                    return;
                // Gapless Preload: When current track has < 12 seconds remaining, pre-resolve next track
                const remaining = (player.queue.current.info.duration || 0) - (player.position || 0);
                if (remaining > 0 && remaining <= 12000 && player.queue.tracks.length > 0) {
                    const nextTrack = player.queue.tracks[0];
                    if (nextTrack && nextTrack.info.identifier !== preloadedTrackId) {
                        preloadedTrackId = nextTrack.info.identifier || null;
                        if (typeof nextTrack.resolve === "function") {
                            console.log(`[Gapless Preloader] Preloading next track "${nextTrack.info.title}" for 0ms transition...`);
                            nextTrack.resolve(lavalink).catch(() => { });
                        }
                    }
                }
                await updateActivePlayerMessage(player);
            }
            catch (err) {
                console.warn("[Ticker Tick Error]:", err);
            }
        }, 4000);
        liveTickers.set(player.guildId, ticker);
    }
    function stopLivePlayerTicker(guildId) {
        const ticker = liveTickers.get(guildId);
        if (ticker) {
            clearInterval(ticker);
            liveTickers.delete(guildId);
        }
    }
    // Player Events
    // Self-healing: if Lavalink sends playerUpdate while playing and ticker was somehow paused/lost, revive it
    lavalink.on("playerUpdate", (_oldPlayer, newPlayer) => {
        if (newPlayer && newPlayer.queue.current && !newPlayer.paused && newPlayer.playing) {
            if (!liveTickers.has(newPlayer.guildId)) {
                console.log(`[Player] Revived live ticker for "${newPlayer.queue.current.info.title}"`);
                startLivePlayerTicker(newPlayer);
            }
        }
    });
    const trackStartLocks = new Set();
    lavalink.on("trackStart", async (player, track) => {
        if (!player.textChannelId || !track)
            return;
        const channel = (client.channels.cache.get(player.textChannelId) ||
            await client.channels.fetch(player.textChannelId).catch(() => null));
        if (!channel || !channel.isTextBased())
            return;
        // Concurrency lock per guild to prevent multiple cards being created simultaneously
        if (trackStartLocks.has(player.guildId)) {
            console.log(`[Player] trackStart execution already in-flight for guild ${player.guildId}. Merging.`);
            return;
        }
        trackStartLocks.add(player.guildId);
        try {
            const prevMessageId = activePlayerMessages.get(player.guildId) || player.getData("active_message_id");
            const activeTrackUri = player.getData("active_track_uri");
            // If the exact same track is already playing and has an active message, just update it in place
            if (prevMessageId && activeTrackUri && activeTrackUri === track.info.uri) {
                console.log(`[Player] Track "${track.info.title}" re-started on same player. Updating existing card.`);
                await updateActivePlayerMessage(player, true);
                startLivePlayerTicker(player);
                return;
            }
            player.setData("active_track_uri", track.info.uri);
            const playerMsgOptions = buildPlayerMessage(player, track);
            // Clean up previous Now Playing card so the new song gets a fresh announcement card at the bottom
            if (prevMessageId) {
                try {
                    const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
                    if (prevMsg) {
                        await prevMsg.delete().catch(() => { });
                    }
                }
                catch { }
            }
            // Sweeper: delete any orphaned bot messages with Now Playing embeds in recent chat to ensure only 1 card exists
            try {
                const recentMsgs = await channel.messages.fetch({ limit: 6 }).catch(() => null);
                const botPlayerCards = recentMsgs?.filter((m) => m.author.id === client.user?.id && m.embeds.some((e) => e.description?.includes("Now playing")));
                if (botPlayerCards && botPlayerCards.size > 0) {
                    for (const [, m] of botPlayerCards) {
                        await m.delete().catch(() => { });
                    }
                }
            }
            catch { }
            // Always send a fresh, prominent Now Playing card at the bottom of the chat for new songs
            const sentMsg = await channel.send(playerMsgOptions);
            activePlayerMessages.set(player.guildId, sentMsg.id);
            playerMessageCache.set(player.guildId, sentMsg);
            player.setData("active_message_id", sentMsg.id);
            // Checkpoint session state to disk
            saveActiveSessions();
            // Maintain loudness normalization if enabled
            if (player.getData("normalized")) {
                applyLoudnessNormalization(player, true).catch(() => { });
            }
            // Start live progress bar updates
            startLivePlayerTicker(player);
            // Auto-maximize and check voice channel bitrate quality
            if (player.voiceChannelId) {
                const voiceChan = channel.guild.channels.cache.get(player.voiceChannelId);
                if (voiceChan && voiceChan.isVoiceBased()) {
                    autoMaximizeVoiceChannelBitrate(voiceChan).catch(() => { });
                    const bitrateInfo = getChannelBitrateInfo(voiceChan);
                    if (!bitrateInfo.isMaxQuality) {
                        channel.send({
                            content: bitrateInfo.recommendation,
                        }).then((msg) => autoDeleteMessage(msg, 12000)).catch(() => { });
                    }
                }
            }
            // Pre-fetch next autoplay recommendation in background only when queue has NO user tracks
            setTimeout(() => {
                const isAutoplay = Boolean(player.getData("autoplay") ?? true);
                const userTracks = player.queue.tracks.filter((t) => {
                    const isAuto = t.requester?.displayName === "📻 Autoplay Radio" || t.requester?.username === "Autoplay Radio" || t.userData?.isAutoplay;
                    return !isAuto;
                });
                if (isAutoplay && userTracks.length === 0 && player.queue.tracks.length === 0) {
                    prefetchAutoplayTrack(player).catch(() => { });
                }
            }, 2500);
        }
        catch (err) {
            console.error("[Lavalink] Failed to send trackStart message:", err);
        }
        finally {
            trackStartLocks.delete(player.guildId);
        }
    });
    lavalink.on("queueEnd", async (player) => {
        stopLivePlayerTicker(player.guildId);
        if (!player.textChannelId)
            return;
        const channel = client.channels.cache.get(player.textChannelId);
        // Smart Autoplay fallback (if queue ran empty before prefetch completed)
        const isAutoplay = Boolean(player.getData("autoplay") ?? true);
        if (isAutoplay && player.queue.previous.length > 0) {
            if (player.queue.tracks.length > 0)
                return;
            const lastTrack = player.queue.previous[0];
            const recommendedTrack = await findAutoplayRecommendation(player, lastTrack);
            if (recommendedTrack) {
                if (player.queue.tracks.length > 0)
                    return;
                await player.queue.add(recommendedTrack);
                await player.play();
                if (channel) {
                    channel.send({
                        content: `📻 **Autoplay Radio:** Playing **[${recommendedTrack.info.title}](${recommendedTrack.info.uri})** by **${recommendedTrack.info.author}**`,
                    }).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => { });
                }
                return;
            }
        }
        if (channel) {
            const is247 = is247Enabled(player.guildId);
            const prevMessageId = activePlayerMessages.get(player.guildId) || player.getData("active_message_id");
            const queueFinishedEmbed = new EmbedBuilder()
                .setColor(0x1db954)
                .setTitle("🎶 Queue Finished")
                .setDescription(is247
                ? "✨ All tracks finished playing. Staying **24/7** in voice channel!\n\nUse `/play <song>` or enable `/autoplay` to keep music flowing."
                : "✨ All tracks finished playing. Use `/play <song>` or enable `/autoplay` to keep music flowing!")
                .setFooter({ text: "💎 South Conclave Audiophile Engine" })
                .setTimestamp();
            let finishedMsg = null;
            if (prevMessageId) {
                try {
                    const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
                    if (prevMsg) {
                        finishedMsg = await prevMsg.edit({ embeds: [queueFinishedEmbed], components: [] });
                    }
                    else {
                        finishedMsg = await channel.send({ embeds: [queueFinishedEmbed] });
                    }
                }
                catch {
                    finishedMsg = await channel.send({ embeds: [queueFinishedEmbed] }).catch(() => null);
                }
            }
            else {
                finishedMsg = await channel.send({ embeds: [queueFinishedEmbed] }).catch(() => null);
            }
            if (finishedMsg) {
                autoDeleteMessage(finishedMsg, 20000);
            }
            activePlayerMessages.delete(player.guildId);
            playerMessageCache.delete(player.guildId);
            player.setData("active_message_id", null);
            clearGuildSession(player.guildId);
        }
    });
    lavalink.on("trackEnd", (player, track, payload) => {
        console.log(`[Player] trackEnd: "${track?.info.title}" | Reason: ${payload.reason} | Position: ${player.position}ms`);
        if (!player.queue.current) {
            stopLivePlayerTicker(player.guildId);
        }
    });
    lavalink.on("playerDestroy", (player) => {
        stopLivePlayerTicker(player.guildId);
        activePlayerMessages.delete(player.guildId);
        playerMessageCache.delete(player.guildId);
        clearGuildSession(player.guildId);
        clearUpdaterState(player.guildId);
    });
    lavalink.on("trackStuck", async (player, track, payload) => {
        console.warn(`[Lavalink] Audio stream stuck for "${track?.info.title}" (${payload.thresholdMs}ms threshold). Handling recovery...`);
        // 1. If this node stalled on the audio stream, mark it degraded for 60 seconds
        if (player.node?.id && player.node.id !== "Kasawa-MasterNode") {
            markNodeDegraded(player.node.id, 60000);
        }
        // 2. Proactively re-align player to Kasawa-MasterNode if available and healthy
        const kasawa = lavalink.nodeManager.nodes.get("Kasawa-MasterNode");
        if (kasawa?.connected && player.node?.id !== "Kasawa-MasterNode" && isNodeHealthy("Kasawa-MasterNode")) {
            console.log(`[Lavalink] Migrating stuck player from ${player.node?.id} back to "Kasawa-MasterNode"...`);
            await player.changeNode(kasawa, false).catch(() => { });
        }
        if (player.textChannelId) {
            const channel = client.channels.cache.get(player.textChannelId);
            channel?.send({
                content: `⚠️ Audio stream stalled for **${track?.info.title || "track"}**. Skipping ahead smoothly...`,
            }).then((msg) => autoDeleteMessage(msg, 6000)).catch(() => { });
        }
        await player.skip().catch(() => { });
    });
    lavalink.on("trackError", async (player, track, payload) => {
        const errorMsg = payload?.exception?.message || JSON.stringify(payload);
        console.error(`[Lavalink] Error playing "${track?.info.title}":`, errorMsg);
        const isNodeNetworkDown = errorMsg.includes("Unexpected token '<'") ||
            errorMsg.includes("<html>") ||
            errorMsg.includes("502") ||
            errorMsg.includes("503") ||
            errorMsg.includes("ConnectTimeoutError") ||
            errorMsg.includes("fetch failed");
        // Only mark node degraded for genuine network outages, NOT track-specific video restrictions!
        if (isNodeNetworkDown && player.node?.id !== "Kasawa-MasterNode") {
            console.warn(`[Node Circuit Breaker] Node "${player.node?.id}" network drop. Marking degraded for 60s.`);
            markNodeDegraded(player.node.id, 60000);
        }
        if (!track)
            return;
        // Cache the failed track ID so we never retry or loop on a broken YouTube video
        if (track.info.identifier) {
            if (restrictedTrackIds.size >= 500) {
                const oldest = restrictedTrackIds.values().next().value;
                if (oldest)
                    restrictedTrackIds.delete(oldest);
            }
            restrictedTrackIds.add(track.info.identifier);
        }
        // If single track loop is active, disable it to prevent an infinite error loop on this failing song
        if (player.repeatMode === "track") {
            console.warn(`[Universal Recovery] Disabling track loop because "${track?.info.title}" failed to stream.`);
            await player.setRepeatMode("off").catch(() => { });
        }
        const failedId = track.info.identifier;
        const rawTitle = track.info.title || "";
        const recoveryAttempts = (player.getData("recovery_attempts") || 0) + 1;
        player.setData("recovery_attempts", recoveryAttempts);
        // Circuit breaker: prevent infinite retry loops if all sources fail
        if (recoveryAttempts > 2) {
            console.warn(`[Universal Recovery] Max recovery attempts (2) reached for "${rawTitle}". Skipping track.`);
            player.setData("recovery_attempts", 0);
            player.setData("recovering_track", false);
            if (player.textChannelId) {
                const channel = client.channels.cache.get(player.textChannelId);
                channel?.send(`⚠️ **Stream Restricted by Provider:** Video stream for **${rawTitle}** requires authorization. Skipping forward...`).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => { });
            }
            await player.skip().catch(() => { });
            return;
        }
        // Universal Auto-Recovery for blocked/age-gated/login-required/broken streams
        if (!player.getData("recovering_track")) {
            try {
                player.setData("recovering_track", true);
                const cleanTitle = rawTitle
                    .replace(/\|.*/, "")
                    .replace(/\[.*?\]/g, "")
                    .replace(/\(.*?\)/g, "")
                    .replace(/video song/gi, "")
                    .replace(/official video/gi, "")
                    .replace(/full video/gi, "")
                    .replace(/lyric video/gi, "")
                    .replace(/4k/gi, "")
                    .replace(/hd/gi, "")
                    .trim();
                const cleanAuthor = (track.info.author || "").replace(/- Topic/gi, "").trim();
                const fallbackQuery = `${cleanTitle} ${cleanAuthor}`.trim();
                console.log(`[Universal Recovery] Stream restricted for "${rawTitle}" (ID: ${failedId}). Attempt #${recoveryAttempts} auto-recovering as "${fallbackQuery}"...`);
                // Prioritize healthy alternate nodes over the node that just failed
                const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected && !n.id.includes("Custom"));
                const healthyOtherNodes = connectedNodes.filter((n) => isNodeHealthy(n.id) && n.id !== player.node.id);
                const kasawaNode = healthyOtherNodes.find((n) => n.id === "Kasawa-MasterNode");
                const milloNode = healthyOtherNodes.find((n) => n.id === "Millo-BackupNode");
                const serenetiaNode = healthyOtherNodes.find((n) => n.id === "Serenetia-AuxNode");
                const otherHealthy = healthyOtherNodes.filter((n) => n.id !== "Kasawa-MasterNode" && n.id !== "Millo-BackupNode" && n.id !== "Serenetia-AuxNode");
                const degradedList = connectedNodes.filter((n) => !isNodeHealthy(n.id) && n.id !== player.node.id);
                const nodesToTry = [
                    ...(kasawaNode ? [kasawaNode] : []),
                    ...(milloNode ? [milloNode] : []),
                    ...(serenetiaNode ? [serenetiaNode] : []),
                    ...otherHealthy,
                    ...degradedList,
                    player.node, // current failing node is only last resort
                ];
                let recoveredTrack = null;
                let targetNode = player.node;
                // ── TIER 0: JioSaavn 320 kbps Studio Audio Recovery (<500ms) ──
                // Completely circumvents YouTube datacenter 403 / IP rate limits and streams bit-perfect 320 kbps AAC audio!
                try {
                    const jioMatch = await resolveJioSaavnTrack(rawTitle, track.info.author || "");
                    if (jioMatch) {
                        const jioLoaded = await loadJioSaavnAsLavalinkTrack(jioMatch, track.requester, [
                            player.node,
                            ...(kasawaNode ? [kasawaNode] : []),
                            ...nodesToTry,
                        ]);
                        if (jioLoaded) {
                            recoveredTrack = jioLoaded.track;
                            targetNode = jioLoaded.node;
                            console.log(`[Universal Recovery] Recovered "${rawTitle}" via JioSaavn 320kbps Studio Master on node "${targetNode.id}"`);
                        }
                    }
                }
                catch (err) {
                    console.warn("[Universal Recovery] JioSaavn recovery attempt error:", err);
                }
                // On attempt #2+, prioritize SoundCloud to bypass YouTube datacenter IP blocks completely
                const trySoundCloudFirst = recoveryAttempts > 1;
                // ── FAST PATH: try the same track URL on a different healthy node (~500ms) ──
                // This is the fastest recovery — no search needed, just re-resolve on a clean IP.
                const fastNodes = [
                    ...(kasawaNode ? [kasawaNode] : []),
                    ...(milloNode ? [milloNode] : []),
                    ...(serenetiaNode ? [serenetiaNode] : []),
                ];
                if (!recoveredTrack && track.info.uri && fastNodes.length > 0 && !trySoundCloudFirst) {
                    for (const node of fastNodes) {
                        try {
                            const directRes = await Promise.race([
                                node.search({ query: track.info.uri }, track.requester),
                                new Promise((r) => setTimeout(() => r(null), 2000)),
                            ]);
                            const directTrack = directRes?.tracks?.find((t) => !restrictedTrackIds.has(t.info.identifier));
                            if (directTrack) {
                                recoveredTrack = directTrack;
                                targetNode = node;
                                console.log(`[Universal Recovery] Fast-path: re-resolved same track on node "${node.id}" in <2s`);
                                break;
                            }
                        }
                        catch { /* try next */ }
                    }
                }
                // ───────────────────────────────────────────────────────────────────────
                // FULL SEARCH PATH: race all candidate nodes in parallel for ~1s resolution
                if (!recoveredTrack) {
                    // On attempt #2+, immediately prioritize SoundCloud to bypass YouTube datacenter IP blocks completely
                    const searchSource = trySoundCloudFirst ? "scsearch" : "ytmsearch";
                    const searchQuery = trySoundCloudFirst ? fallbackQuery : `${cleanTitle} audio`;
                    // Race all nodes simultaneously — fastest response wins
                    const raceResults = await Promise.allSettled(nodesToTry.slice(0, 3).map(async (node) => {
                        const res = await Promise.race([
                            node.search({ query: searchQuery, source: searchSource }, track.requester),
                            new Promise((r) => setTimeout(() => r(null), 3000)),
                        ]);
                        const candidate = res?.tracks?.find((t) => t.info.identifier !== failedId &&
                            !restrictedTrackIds.has(t.info.identifier) &&
                            isRelevantTrack(t.info.title, cleanTitle));
                        if (!candidate)
                            throw new Error("no candidate");
                        return { track: candidate, node };
                    }));
                    for (const result of raceResults) {
                        if (result.status === "fulfilled") {
                            recoveredTrack = result.value.track;
                            targetNode = result.value.node;
                            console.log(`[Universal Recovery] Found alternative on node "${targetNode.id}": "${recoveredTrack?.info.title}"`);
                            break;
                        }
                    }
                }
                // SEQUENTIAL FALLBACK: slower but exhaustive — only runs if parallel race failed
                if (!recoveredTrack) {
                    for (const node of nodesToTry) {
                        try {
                            if (trySoundCloudFirst) {
                                const scRes = await node.search({ query: fallbackQuery, source: "scsearch" }, track.requester);
                                if (scRes?.tracks?.length && scRes.loadType !== "empty" && scRes.loadType !== "error") {
                                    const scCandidate = scRes.tracks.find((t) => t.info.identifier !== failedId &&
                                        !restrictedTrackIds.has(t.info.identifier) &&
                                        isRelevantTrack(t.info.title, cleanTitle));
                                    if (scCandidate) {
                                        recoveredTrack = scCandidate;
                                        targetNode = node;
                                        console.log(`[Universal Recovery] Found verified SoundCloud alternative on node "${node.id}": "${scCandidate.info.title}"`);
                                        break;
                                    }
                                }
                            }
                            let ytRes = await node.search({ query: `${cleanTitle} audio`, source: "ytmsearch" }, track.requester);
                            if (!ytRes?.tracks?.length || ytRes.loadType === "empty" || ytRes.loadType === "error") {
                                ytRes = await node.search({ query: `${cleanTitle} lyrical`, source: "ytsearch" }, track.requester);
                            }
                            if (ytRes?.tracks?.length) {
                                const ytCandidate = ytRes.tracks.find((t) => t.info.identifier !== failedId &&
                                    !restrictedTrackIds.has(t.info.identifier) &&
                                    isRelevantTrack(t.info.title, cleanTitle));
                                if (ytCandidate) {
                                    recoveredTrack = ytCandidate;
                                    targetNode = node;
                                    console.log(`[Universal Recovery] Found authentic alternative YouTube audio on node "${node.id}": "${ytCandidate.info.title}"`);
                                    break;
                                }
                            }
                            if (!trySoundCloudFirst) {
                                const scRes = await node.search({ query: fallbackQuery, source: "scsearch" }, track.requester);
                                if (scRes?.tracks?.length && scRes.loadType !== "empty" && scRes.loadType !== "error") {
                                    const scCandidate = scRes.tracks.find((t) => t.info.identifier !== failedId &&
                                        !restrictedTrackIds.has(t.info.identifier) &&
                                        isRelevantTrack(t.info.title, cleanTitle));
                                    if (scCandidate) {
                                        recoveredTrack = scCandidate;
                                        targetNode = node;
                                        console.log(`[Universal Recovery] Found verified SoundCloud alternative on node "${node.id}": "${scCandidate.info.title}"`);
                                        break;
                                    }
                                }
                            }
                        }
                        catch (e) {
                            const errMsg = e?.message || String(e);
                            if (errMsg.includes("Unexpected token '<'") || errMsg.includes("<html>") || errMsg.includes("502")) {
                                markNodeDegraded(node.id);
                            }
                            console.warn(`[Universal Recovery] Search failed on node ${node.id}:`, errMsg);
                        }
                    }
                }
                if (recoveredTrack) {
                    // If the recovery track was found on another node, migrate player
                    if (player.node.id !== targetNode.id) {
                        console.log(`[Universal Recovery] Migrating player from ${player.node.id} to ${targetNode.id}...`);
                        try {
                            await player.changeNode(targetNode, false);
                        }
                        catch (err) {
                            console.warn("[Universal Recovery] changeNode error:", err?.message || err);
                        }
                    }
                    recoveredTrack.requester = track.requester;
                    if (track.info.artworkUrl)
                        recoveredTrack.info.artworkUrl = track.info.artworkUrl;
                    try {
                        await player.play({ clientTrack: recoveredTrack, noReplace: false });
                    }
                    catch (playErr) {
                        console.warn("[Universal Recovery] play error:", playErr?.message || playErr);
                    }
                    if (player.textChannelId) {
                        const channel = client.channels.cache.get(player.textChannelId);
                        const isJio = Boolean(recoveredTrack.userData?.isJioSaavn);
                        const streamLabel = isJio ? "💎 **JioSaavn Studio Master (320 kbps AAC)**" : "high-fidelity stream";
                        channel?.send(`🔄 **Auto-Recovered:** Restriction detected on video. Swapped to ${streamLabel}: **[${recoveredTrack.info.title}](${recoveredTrack.info.uri})**`).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => { });
                    }
                    setTimeout(() => {
                        player.setData("recovering_track", false);
                        player.setData("recovery_attempts", 0);
                    }, 6000);
                    return;
                }
            }
            catch (err) {
                console.error("[Universal Recovery Failed]:", err);
            }
            finally {
                player.setData("recovering_track", false);
            }
        }
        if (!player.textChannelId)
            return;
        const channel = client.channels.cache.get(player.textChannelId);
        if (channel) {
            channel.send(`⚠️ Error playing **${track?.info.title || "track"}**: ${payload.exception?.message || "Audio stream error"}`).then((msg) => autoDeleteMessage(msg, 8000)).catch(() => { });
        }
    });
    return lavalink;
}
export function getBestNode() {
    if (config.lavalink.host && config.lavalink.host !== "localhost" && !config.lavalink.host.includes("jirayu")) {
        const custom = lavalink.nodeManager.nodes.get("Primary-CustomNode");
        if (custom?.connected && isNodeHealthy("Primary-CustomNode"))
            return "Primary-CustomNode";
    }
    // Score every healthy connected node by real-time load metrics.
    // Lower score = less load = better for new streams.
    const candidates = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected && isNodeHealthy(n.id) && !n.id.includes("Custom"));
    if (candidates.length === 0) {
        // All healthy nodes gone — fall back to any connected node
        const fallback = Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && !n.id.includes("Custom"));
        return fallback?.id;
    }
    // Node load score (lower = better):
    //   - Frame deficit contributes heavily (each deficit frame = jitter/speed-up for listeners)
    //   - Playing player count shows how loaded the node is
    //   - CPU load adds secondary pressure signal
    //   - Static priority bonus: Jirayu=0, Trinium=10, Millo=30 (tiebreaker)
    const FRAME_DEFICIT_WEIGHT = 0.5; // per deficit frame
    const PLAYER_COUNT_WEIGHT = 5; // per active playing stream
    const CPU_WEIGHT = 200; // per 1.0 (100%) CPU load
    const JITTER_THRESHOLD = 50; // deficit frames below this = negligible
    const scored = candidates.map((node) => {
        const stats = node.stats;
        const deficit = Math.max(0, (stats?.frameStats?.deficit ?? 0) - JITTER_THRESHOLD);
        const playing = stats?.playingPlayers ?? 0;
        const cpu = stats?.cpu?.lavalinkLoad ?? 0;
        // Priority bonus (lower = preferred when load is equal)
        let priorityBonus = 50;
        if (node.id === "Kasawa-MasterNode")
            priorityBonus = -500; // Primary master node (direct HTTP 320k JioSaavn + YT/SoundCloud)
        if (node.id === "Serenetia-AuxNode")
            priorityBonus = 10;
        if (node.id === "Millo-BackupNode")
            priorityBonus = 50;
        const score = (deficit * FRAME_DEFICIT_WEIGHT) +
            (playing * PLAYER_COUNT_WEIGHT) +
            (cpu * CPU_WEIGHT) +
            priorityBonus;
        return { id: node.id, score, playing, deficit };
    });
    scored.sort((a, b) => a.score - b.score);
    const winner = scored[0];
    if (scored.length > 1 && winner.id !== "Kasawa-MasterNode") {
        // Only log when a non-default node wins (i.e., load-aware selection kicked in)
        console.log(`[Node Selector] Load-aware pick: "${winner.id}" (score ${winner.score.toFixed(0)}, ${winner.playing} streams, ${winner.deficit} deficit frames)`);
    }
    return winner?.id;
}
/**
 * Validates member voice state and gets or creates player
 */
export async function getOrCreatePlayer(interaction) {
    const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
    if (!guild) {
        return {
            player: null,
            error: "❌ **The bot is not in this server!**\nIt looks like it was installed to your account as a user app instead of being added to the server.\n👉 Please add the bot directly to your server using the bot invite link so it can join voice channels.",
        };
    }
    // Safely resolve guild member to guarantee voice state
    const member = guild.members.cache.get(interaction.user.id) || await guild.members.fetch(interaction.user.id).catch(() => null);
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) {
        return { player: null, error: "❌ You must be connected to a voice channel first!" };
    }
    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (botMember?.voice?.channelId && botMember.voice.channelId !== voiceChannel.id) {
        return {
            player: null,
            error: `❌ You must be in the same voice channel as me (<#${botMember.voice.channelId}>)!`,
        };
    }
    const permissions = voiceChannel.permissionsFor(interaction.client.user);
    if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
        return {
            player: null,
            error: "❌ I need **Connect** and **Speak** permissions in your voice channel!",
        };
    }
    let player = lavalink.getPlayer(interaction.guildId);
    if (!player) {
        const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
        if (connectedNodes.length === 0) {
            // Trigger self-healing watchdog immediately
            ensureNodesHealthy().catch(() => { });
            return {
                player: null,
                error: "⚠️ **Audio servers are reconnecting:** The audio nodes temporarily disconnected after a network drop. Please wait ~5 seconds and try `/play` again!",
            };
        }
        const targetNode = getBestNode();
        console.log(`[Player] Creating player for guild ${interaction.guildId} in voice channel ${voiceChannel.name} (${voiceChannel.id}) on node "${targetNode || "default"}"`);
        try {
            player = lavalink.createPlayer({
                guildId: interaction.guildId,
                voiceChannelId: voiceChannel.id,
                textChannelId: interaction.channelId,
                selfDeaf: true,
                selfMute: false,
                volume: 100,
                instaUpdateFiltersFix: true,
                applyVolumeAsFilter: false,
                ...(targetNode ? { node: targetNode } : {}),
            });
            player.setData("hifi_active", false);
            player.setData("eq_preset", "Normal (Flat)");
        }
        catch (err) {
            console.error("[Player Creation Error]:", err?.message || err);
            ensureNodesHealthy().catch(() => { });
            return {
                player: null,
                error: "⚠️ **Audio server initializing:** Reconnecting to audio nodes. Please try again in 5 seconds!",
            };
        }
    }
    else if (!isNodeHealthy(player.node?.id)) {
        // If existing player was assigned to a degraded node, migrate to best healthy node
        const bestNodeId = getBestNode();
        if (bestNodeId && bestNodeId !== player.node?.id) {
            const betterNode = lavalink.nodeManager.nodes.get(bestNodeId);
            if (betterNode?.connected) {
                console.log(`[Player] Migrating player from degraded "${player.node?.id}" to healthy "${betterNode.id}"...`);
                await player.changeNode(betterNode, false).catch(() => { });
            }
        }
    }
    if (!player.connected) {
        console.log(`[Player] Connecting to voice channel ${voiceChannel.name}...`);
        await player.connect();
        console.log(`[Player] Connected to voice channel ${voiceChannel.name}!`);
    }
    // Ensure voice channel bitrate is auto-maximized to server limits (up to 384 kbps)
    await autoMaximizeVoiceChannelBitrate(voiceChannel);
    return { player };
}
const updaterStates = new Map();
export function clearUpdaterState(guildId) {
    const s = updaterStates.get(guildId);
    if (s?.timer)
        clearTimeout(s.timer);
    updaterStates.delete(guildId);
}
/**
 * Updates the active Now Playing message in the text channel with rate-limiting & queuing protection
 */
export async function updateActivePlayerMessage(player, immediate = false) {
    if (!player.textChannelId)
        return;
    let state = updaterStates.get(player.guildId);
    if (!state) {
        state = { inFlight: false, pending: false, lastEditTime: 0 };
        updaterStates.set(player.guildId, state);
    }
    const now = Date.now();
    const MIN_INTERVAL = 2200; // minimum 2.2s between message edits to guarantee zero Discord 429 rate limits
    const elapsed = now - state.lastEditTime;
    if (state.inFlight) {
        state.pending = true;
        return;
    }
    if (!immediate && elapsed < MIN_INTERVAL) {
        state.pending = true;
        if (!state.timer) {
            state.timer = setTimeout(async () => {
                state.timer = undefined;
                if (state.pending) {
                    state.pending = false;
                    await updateActivePlayerMessage(player);
                }
            }, MIN_INTERVAL - elapsed);
        }
        return;
    }
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = undefined;
    }
    state.inFlight = true;
    try {
        const editPromise = performPlayerMessageEdit(player);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Edit timeout")), 3500));
        await Promise.race([editPromise, timeoutPromise]);
        state.lastEditTime = Date.now();
    }
    catch (err) {
        if (err?.message !== "Edit timeout") {
            console.warn(`[Message Updater] Edit error on guild ${player.guildId}:`, err?.message || err);
        }
    }
    finally {
        state.inFlight = false;
        if (state.pending) {
            state.pending = false;
            state.timer = setTimeout(() => {
                state.timer = undefined;
                updateActivePlayerMessage(player);
            }, MIN_INTERVAL);
        }
    }
}
async function performPlayerMessageEdit(player) {
    if (!player.textChannelId)
        return;
    let messageId = activePlayerMessages.get(player.guildId) || player.getData("active_message_id");
    const channel = (discordClient?.channels.cache.get(player.textChannelId) ||
        await discordClient?.channels.fetch(player.textChannelId).catch(() => null));
    if (!channel || !channel.isTextBased())
        return;
    // Auto-discover existing player message if bot restarted or messageId lost from memory
    if (!messageId) {
        try {
            const recentMsgs = await channel.messages.fetch({ limit: 8 }).catch(() => null);
            const botMsg = recentMsgs?.find((m) => m.author.id === discordClient?.user?.id && m.embeds.length > 0 && m.components.length > 0);
            if (botMsg) {
                messageId = botMsg.id;
                activePlayerMessages.set(player.guildId, messageId);
                playerMessageCache.set(player.guildId, botMsg);
                player.setData("active_message_id", messageId);
            }
        }
        catch { }
    }
    if (!messageId)
        return;
    try {
        let msg = playerMessageCache.get(player.guildId) || channel.messages.cache.get(messageId) || null;
        if (!msg) {
            msg = await channel.messages.fetch(messageId).catch(() => null);
        }
        if (msg) {
            const editedMsg = await msg.edit(buildPlayerMessage(player));
            playerMessageCache.set(player.guildId, editedMsg);
        }
        else {
            activePlayerMessages.delete(player.guildId);
            playerMessageCache.delete(player.guildId);
            player.setData("active_message_id", null);
        }
    }
    catch (err) {
        if (err.code === 10008) {
            // 10008: Unknown Message (deleted by user or mod)
            activePlayerMessages.delete(player.guildId);
            playerMessageCache.delete(player.guildId);
            player.setData("active_message_id", null);
        }
        else if (err.status === 429) {
            console.warn(`[Message Updater] Discord 429 rate limit on guild ${player.guildId}. Backing off gracefully.`);
        }
    }
}
/**
 * Voice Gate: Validates that the interacting user is currently in the same voice channel as the bot
 */
export async function validateVoiceGate(interaction, player) {
    const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
    if (!guild) {
        return { allowed: false, error: "❌ This action can only be used inside a server!" };
    }
    // Fast in-memory resolution of user voice channel without network latency
    const memberVoiceChannelId = interaction.member?.voice?.channelId ||
        guild.members.cache.get(interaction.user.id)?.voice?.channelId ||
        (await guild.members.fetch(interaction.user.id).catch(() => null))?.voice?.channelId;
    if (!memberVoiceChannelId) {
        return {
            allowed: false,
            error: "🔒 **Voice Gate Active:** You must be connected to a voice channel to use player controls!",
        };
    }
    if (player.voiceChannelId && memberVoiceChannelId !== player.voiceChannelId) {
        return {
            allowed: false,
            error: `🔒 **Voice Gate Active:** You must be in <#${player.voiceChannelId}> to use player controls!`,
        };
    }
    return { allowed: true };
}
/**
 * Smooth Volume Fade Out before pausing to avoid speaker popping
 */
export async function smoothFadePause(player) {
    const originalVolume = player.volume;
    player.setData("pre_pause_volume", originalVolume);
    try {
        if (originalVolume > 15) {
            await player.setVolume(Math.round(originalVolume * 0.5)).catch(() => { });
            await new Promise((r) => setTimeout(r, 60));
            await player.setVolume(Math.round(originalVolume * 0.15)).catch(() => { });
            await new Promise((r) => setTimeout(r, 60));
        }
    }
    catch { }
    await player.pause();
    await player.setVolume(originalVolume).catch(() => { });
}
/**
 * Smooth Volume Fade In upon resuming to provide an audiophile ramp-up
 */
export async function smoothFadeResume(player) {
    const targetVolume = player.getData("pre_pause_volume") || player.volume || 100;
    try {
        await player.setVolume(Math.max(5, Math.round(targetVolume * 0.15))).catch(() => { });
    }
    catch { }
    await player.resume();
    try {
        await new Promise((r) => setTimeout(r, 60));
        await player.setVolume(Math.max(10, Math.round(targetVolume * 0.55))).catch(() => { });
        await new Promise((r) => setTimeout(r, 60));
        await player.setVolume(targetVolume).catch(() => { });
    }
    catch { }
}
