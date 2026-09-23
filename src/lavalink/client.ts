import { resolveRecoveryTrack } from "../services/recovery.js";
import { confirmedTrack, RecentFailures, withTimeout } from "../utils/playback.js";
import { authorConfidence, hasUnrequestedVersion, sameRecording, rankSearchTracks, isPreferredRadioUpload } from "../utils/trackSelection.js";
import { isLoopbackHost, nodeErrorSummary } from "../utils/nodeDiagnostics.js";
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GuildMember,
  Message,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import { LavalinkManager, LavalinkNodeOptions, Player, Track } from "lavalink-client";
import { config } from "../config.js";
import { buildPlayerMessage } from "./playerUI.js";
import { autoDeleteMessage } from "../utils/cleanup.js";
import { detectTrackLanguage, getChannelBitrateInfo, isLanguageCompatible, isRelevantTrack, parseTrackTitle, MusicLanguage } from "../utils/formatters.js";
import { is247Enabled } from "../utils/twentyFourSeven.js";
import { clearGuildSession, saveActiveSessions } from "../utils/sessionRecovery.js";
import { applyLoudnessNormalization } from "../commands/normalize.js";
import { findJioSaavnAutoplay, loadJioSaavnAsLavalinkTrack, resolveJioSaavnTrack } from "../services/jiosaavn.js";

export let lavalink: LavalinkManager;
export let discordClient: Client;

// Track active player messages so we can update or clean them up
export const activePlayerMessages = new Map<string, string>(); // guildId -> messageId
export const playerMessageCache = new Map<string, Message>(); // guildId -> Message object (fast direct edit)

// Short cooldown for failed recordings; provider restrictions may be temporary.
export const restrictedTrackIds = new RecentFailures();

// YouTube playback health: tracks whether YouTube streams are working at all.
// When YouTube is globally blocked (all clients fail), skip doomed retries and
// go straight to JioSaavn and SoundCloud recovery for instant, stutter-free playback.
const ytPlaybackFailures: number[] = [];
const YT_HEALTH_WINDOW_MS = 600000; // 10-minute sliding window
const YT_HEALTH_FAIL_THRESHOLD = 1; // 1 failure within window = YouTube is degraded

export function recordYouTubePlaybackFailure(): void {
  ytPlaybackFailures.push(Date.now());
  // Trim old entries outside the window
  const cutoff = Date.now() - YT_HEALTH_WINDOW_MS;
  while (ytPlaybackFailures.length > 0 && ytPlaybackFailures[0] < cutoff) ytPlaybackFailures.shift();
}

export function recordYouTubePlaybackSuccess(): void {
  // A verified success resets the health tracker
  ytPlaybackFailures.length = 0;
}

export function isYouTubePlaybackHealthy(): boolean {
  const cutoff = Date.now() - YT_HEALTH_WINDOW_MS;
  while (ytPlaybackFailures.length > 0 && ytPlaybackFailures[0] < cutoff) ytPlaybackFailures.shift();
  return ytPlaybackFailures.length < YT_HEALTH_FAIL_THRESHOLD;
}

// Dynamic node health & circuit breaker: tracks nodes returning 502/HTML errors or timeouts
export const degradedNodes = new Map<string, number>(); // nodeId -> expiry timestamp

export function markNodeDegraded(nodeId: string, durationMs: number = 180000): void {
  console.warn(`[Node Circuit Breaker] Marking node "${nodeId}" as degraded for ${Math.round(durationMs / 1000)}s`);
  degradedNodes.set(nodeId, Date.now() + durationMs);
}

export function isNodeHealthy(nodeId: string): boolean {
  const expiry = degradedNodes.get(nodeId);
  if (!expiry) return true;
  if (Date.now() > expiry) {
    degradedNodes.delete(nodeId);
    return true;
  }
  return false;
}

/**
 * Disables DSP filters and EQ. Discord output may still be transcoded by the node.
 */
export async function clearAllFilters(player: Player): Promise<void> {
  if (!player) return;
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
  } catch (err) {
    console.warn("[Player Filters] Error clearing filters:", err);
  }
}

/**
 * Auto-maximizes voice channel bitrate to server peak (up to 384 kbps for Tier 3, 256 kbps for Tier 2, 128 kbps for Tier 1, 96 kbps for Tier 0)
 */
export async function autoMaximizeVoiceChannelBitrate(voiceChannel: VoiceBasedChannel | null | undefined): Promise<void> {
  if (!voiceChannel) return;
  try {
    // Cap voice channel bitrate to 192 kbps. Forcing 384 kbps causes severe UDP packet loss,
    // jitter buffer exhaustion, and stuttering for mobile/remote listeners.
    // 192 kbps delivers studio-grade transparent stereo Opus with zero audio drops.
    const maxBitrate = Math.min(voiceChannel.guild.maximumBitrate, 192000);
    if (voiceChannel.bitrate < maxBitrate) {
      const botMember = voiceChannel.guild.members.me;
      if (botMember && voiceChannel.permissionsFor(botMember)?.has("ManageChannels")) {
        await voiceChannel.setBitrate(maxBitrate, "Music playback: use available channel bitrate");
        console.log(`[Audio Quality] Optimized voice channel "${voiceChannel.name}" to ${Math.round(maxBitrate / 1000)} kbps.`);
      }
    }
  } catch {}
}

/**
 * Validates that an autoplay recommendation is a genuine new song and not a live/remix/cover of a previous song
 */
export function isSameSongOrJunk(candidateTitle: string, previousTracks: any[]): boolean {
  const simplify = (str: string) => {
    const parsed = parseTrackTitle(str);
    return (parsed.songTitle || str)
      .toLowerCase()
      .replace(/feat\..*/g, "")
      .replace(/ft\..*/g, "")
      .replace(/remix.*/g, "")
      .replace(/version.*/g, "")
      .replace(/[^\p{L}\p{M}\p{N}]/gu, "");
  };

  const lowTitle = candidateTitle.toLowerCase();
  const junkKeywords = ["karaoke", "instrumental", "tutorial", "tribute", "how to play", "synthesia", "cover", "bass boosted"];
  if (hasUnrequestedVersion(candidateTitle) || junkKeywords.some((j) => lowTitle.includes(j))) return true;

  const candSimp = simplify(candidateTitle);
  if (!candSimp) return true;

  for (const prev of previousTracks) {
    const prevTitle = prev?.info?.title || "";
    const prevSimp = simplify(prevTitle);
    if (prevSimp && (candSimp === prevSimp || (candSimp.length >= 6 && prevSimp.length >= 6 && (candSimp.includes(prevSimp) || prevSimp.includes(candSimp))))) {
      return true; // Collision with a previously played song!
    }
  }
  return false;
}

/**
 * Spotify/FlaviBot-Grade Recommendation Engine:
 * Generates acoustic neural radio seeds (RD<videoId>), diversifies by 80% same genre/vibe from other artists,
 * and checks catalog candidates against song identity before replacing an upload.
 */
const recommendationJobs = new WeakMap<Player, { seed: Track; job: Promise<Track | null> }>();
export function findAutoplayRecommendation(player: Player, seedTrack: Track): Promise<Track | null> {
  const pending = recommendationJobs.get(player);
  if (pending?.seed === seedTrack) return pending.job;
  const job = discoverAutoplayRecommendation(player, seedTrack).finally(() => {
    if (recommendationJobs.get(player)?.job === job) recommendationJobs.delete(player);
  });
  recommendationJobs.set(player, { seed: seedTrack, job });
  return job;
}
async function discoverAutoplayRecommendation(player: Player, seedTrack: Track): Promise<Track | null> {
  const rawTitle = seedTrack.info.title || "";
  const rawAuthor = (seedTrack.info.author || "").replace(/- Topic/gi, "").trim();
  const parsedSeed = parseTrackTitle(rawTitle, rawAuthor);
  const cleanTitle = parsedSeed.songTitle || rawTitle;
  const fullSeedQuery = parsedSeed.fullSearchQuery || `${cleanTitle} ${rawAuthor}`.trim();
  const effectiveArtist = parsedSeed.artist;
  const videoId = seedTrack.info.identifier;

  const declaredLanguage = (seedTrack.userData as any)?.language;
  const seedLang: MusicLanguage = ["tamil", "telugu", "malayalam", "kannada", "hindi", "punjabi", "english", "korean", "japanese"].includes(declaredLanguage)
    ? declaredLanguage : detectTrackLanguage(rawTitle, rawAuthor);
  console.log(`[Smart Autoplay] Finding AI radio recommendations based on "${cleanTitle}" by "${effectiveArtist}" (Language: ${seedLang.toUpperCase()})...`);

  const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected);
  const healthyNodes = connectedNodes.filter((n: any) => isNodeHealthy(n.id));
  const customNode = healthyNodes.find((n: any) => n.id === "Primary-CustomNode");
  const kasawaNode = healthyNodes.find((n: any) => n.id === "Kasawa-MasterNode");
  const milloNode = healthyNodes.find((n: any) => n.id === "Millo-BackupNode");
  const serenetiaNode = healthyNodes.find((n: any) => n.id === "Serenetia-AuxNode");
  const otherHealthy = healthyNodes.filter((n: any) => n.id !== "Primary-CustomNode" && n.id !== "Kasawa-MasterNode" && n.id !== "Millo-BackupNode" && n.id !== "Serenetia-AuxNode");
  const degradedList = connectedNodes.filter((n: any) => !isNodeHealthy(n.id));

  // Priority: Custom Primary Node > Kasawa > Millo > Serenetia
  const nodesToTry = healthyNodes.length > 0 ? [
    ...(customNode ? [customNode] : []),
    ...(kasawaNode ? [kasawaNode] : []),
    ...(milloNode ? [milloNode] : []),
    ...(serenetiaNode ? [serenetiaNode] : []),
    ...otherHealthy,
  ] : degradedList;

  const historyIds = new Set(player.queue.previous.map((t) => t.info.identifier).filter((id): id is string => Boolean(id)));
  if (player.queue.current?.info.identifier) historyIds.add(player.queue.current.info.identifier);
  for (const t of player.queue.tracks) {
    if (t.info.identifier) historyIds.add(t.info.identifier);
  }

  for (const t of [seedTrack, ...player.queue.previous, ...player.queue.tracks]) {
    const jioId = (t.userData as any)?.jioId;
    if (jioId) historyIds.add(jioId);
  }
  let foundCandidate: Track | null = null;

  const isJioSeed = Boolean((seedTrack.userData as any)?.isJioSaavn) || seedTrack.info.sourceName === "jiosaavn";
  const seedJioId = String((seedTrack.userData as any)?.jioId || "");
  const seedAlbum = String((seedTrack.userData as any)?.album || "");
  const previousArtists = [
    ...player.queue.previous.map(t => t.info?.author),
    player.queue.current?.info?.author,
  ].filter((artist): artist is string => Boolean(artist));

  const previousTitles = [
    cleanTitle,
    rawTitle,
    parsedSeed.fullSearchQuery,
    ...(player.queue.current?.info?.title ? [player.queue.current.info.title] : []),
    ...player.queue.previous.map((t) => t.info?.title).filter(Boolean),
    ...player.queue.tracks.map((t) => t.info?.title).filter(Boolean),
  ];

  // Check YouTube health before resolving seed to avoid wasting 3.5s when YouTube is broken
  const ytHealthy = isYouTubePlaybackHealthy();

  // Resolve every seed into the YouTube Music catalog first. JioSaavn tracks
  // use their title/artist to locate the same recording and its YTM radio ID.
  let ytmRadioSeedId = !isJioSeed && /^[a-zA-Z0-9_-]{11}$/.test(videoId || "") ? videoId : "";
  if (!ytmRadioSeedId && ytHealthy) {
    for (const node of nodesToTry) {
      try {
        const seedRes: any = await withTimeout(
          node.search({ query: fullSeedQuery, source: "ytmsearch" }, seedTrack.requester),
          3500
        );
        const catalogSeed = rankSearchTracks<any>(seedRes?.tracks || [], cleanTitle)
          .find(t => isPreferredRadioUpload(t.info) && sameRecording(t.info, seedTrack.info));
        if (catalogSeed && /^[a-zA-Z0-9_-]{11}$/.test(catalogSeed.info.identifier || "")) {
          ytmRadioSeedId = catalogSeed.info.identifier;
          console.log(`[Smart Autoplay] Matched YTM radio seed: "${catalogSeed.info.title}" by "${catalogSeed.info.author}"`);
          break;
        }
      } catch {}
    }
  }

  // Strategy 1: YouTube Music native radio mix. This decides which related
  // song comes next; JioSaavn may provide the audio stream after selection.
  // Skip this entirely when YouTube playback is known-broken to avoid wasting
  // 3-7 seconds on doomed network calls that cause stuttering.
  if (ytmRadioSeedId && ytHealthy) {
    const radioUrl = `https://www.youtube.com/watch?v=${ytmRadioSeedId}&list=RD${ytmRadioSeedId}`;
    for (const node of nodesToTry) {
      try {
        const radioPromise = node.search({ query: radioUrl }, seedTrack.requester);
        const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 3500));
        const radioRes: any = await Promise.race([radioPromise, timeoutPromise]);
        if (radioRes?.tracks?.length && radioRes.loadType !== "error" && radioRes.loadType !== "empty") {
          const validCandidates = radioRes.tracks.filter(
            (t: any) =>
              isPreferredRadioUpload(t.info) &&
              !historyIds.has(t.info.identifier) &&
              !restrictedTrackIds.has(t.info.identifier) &&
              !isSameSongOrJunk(t.info.title, [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])]) &&
              (t.info.duration || 0) >= 60000 &&
              (t.info.duration || 0) <= 900000 &&
              isLanguageCompatible(seedLang, detectTrackLanguage(t.info.title, t.info.author || ""))
          );

          if (validCandidates.length > 0) {
            // Prioritize candidates with the EXACT same language (e.g. Tamil -> Tamil)
            const exactLangCandidates = validCandidates.filter(
              (t: any) => detectTrackLanguage(t.info.title, t.info.author || "") === seedLang
            );
            const candidatePool = (exactLangCandidates.length > 0 ? exactLangCandidates : validCandidates)
              .sort((a: any, b: any) => authorConfidence(b.info.author) - authorConfidence(a.info.author));

            // Provider order breaks ties; upload reputation takes priority over random diversity.
            const candidate: Track | undefined = candidatePool[0];

            if (candidate) {
              foundCandidate = candidate;
              break;
            }
          }
        }
      } catch (e: any) {
        const errMsg = e?.message || String(e);
        if (errMsg.includes("Unexpected token '<'") || errMsg.includes("<html>") || errMsg.includes("502") || errMsg.includes("ConnectTimeoutError") || errMsg.includes("fetch failed") || errMsg.includes("timeout")) {
          markNodeDegraded(node.id);
        }
      }
    }
  } else if (!ytHealthy && ytmRadioSeedId) {
    console.log(`[Smart Autoplay] Skipping YouTube radio (YouTube playback unhealthy: ${ytPlaybackFailures.length} recent failures). Going straight to JioSaavn.`);
  }

  // Strategy 2: Curated artist hits & similar song search across nodes if RD playlist did not match
  // When YouTube is broken, skip Strategy 2 (ytmsearch still works for metadata
  // selection even if playback will fail — but we prefer JioSaavn-first in Strategy 3).
  if (!foundCandidate && ytHealthy) {
    const queriesToTry: string[] = [];
    if (seedLang !== "global" && seedLang !== "english") {
      queriesToTry.push(
        `${fullSeedQuery} songs`,
        `${cleanTitle} similar ${seedLang} songs`,
        `${effectiveArtist} ${seedLang} hit songs`,
        `${effectiveArtist} ${seedLang} radio`
      );
    } else {
      queriesToTry.push(
        `${fullSeedQuery} similar songs`,
        `${cleanTitle} mix`,
        `${effectiveArtist} similar artists`,
        `${effectiveArtist} top tracks`
      );
    }

    for (const query of queriesToTry) {
      if (foundCandidate) break;
      for (const node of nodesToTry) {
        try {
          const searchPromise = node.search({ query, source: "ytmsearch" }, seedTrack.requester);
          const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 3500));
          const recRes: any = await Promise.race([searchPromise, timeoutPromise]);
          if (recRes?.tracks?.length && recRes.loadType !== "empty" && recRes.loadType !== "error") {
            const candidate = [...recRes.tracks].sort((a: any, b: any) => authorConfidence(b.info.author) - authorConfidence(a.info.author)).find(
              (t: any) =>
                isPreferredRadioUpload(t.info) &&
                !historyIds.has(t.info.identifier) &&
                !restrictedTrackIds.has(t.info.identifier) &&
                !isSameSongOrJunk(t.info.title, [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])]) &&
                (t.info.duration || 0) >= 60000 &&
                (t.info.duration || 0) <= 900000 &&
                isLanguageCompatible(seedLang, detectTrackLanguage(t.info.title, t.info.author || ""))
            );
            if (candidate) {
              foundCandidate = candidate;
              break;
            }
          }
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          if (errMsg.includes("Unexpected token '<'") || errMsg.includes("<html>") || errMsg.includes("502") || errMsg.includes("ConnectTimeoutError") || errMsg.includes("fetch failed") || errMsg.includes("timeout")) {
            markNodeDegraded(node.id);
          }
        }
      }
    }
  }

  // Strategy 3: Native JioSaavn discovery is the fallback when YTM did not
  // return a safe related song.
  if (!foundCandidate) {
    try {
      const jioRec = await findJioSaavnAutoplay(cleanTitle, effectiveArtist, seedLang, historyIds, previousTitles, seedJioId, previousArtists, seedAlbum);
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
    } catch (e) {
      console.warn("[Smart Autoplay] JioSaavn autoplay discovery notice:", e);
    }
  }

  // Strategy 4: SoundCloud discovery if neither YouTube nor JioSaavn found a candidate
  if (!foundCandidate) {
    try {
      const scQueries = [
        `${effectiveArtist} ${cleanTitle}`,
        `${cleanTitle} radio`,
        `${effectiveArtist} top tracks`,
      ];
      for (const scQuery of scQueries) {
        if (foundCandidate) break;
        for (const node of nodesToTry) {
          try {
            const scRes: any = await withTimeout(
              node.search({ query: scQuery, source: "scsearch" }, seedTrack.requester),
              3500
            );
            if (scRes?.tracks?.length && scRes.loadType !== "empty" && scRes.loadType !== "error") {
              const candidate = scRes.tracks.find((t: any) =>
                !historyIds.has(t.info.identifier) &&
                !restrictedTrackIds.has(t.info.identifier) &&
                !isSameSongOrJunk(t.info.title, [...player.queue.previous, ...(player.queue.current ? [player.queue.current] : [])]) &&
                (t.info.duration || 0) >= 60000 &&
                (t.info.duration || 0) <= 900000
              );
              if (candidate) {
                foundCandidate = candidate;
                console.log(`[Smart Autoplay] SoundCloud discovery candidate: "${foundCandidate?.info?.title}" by "${foundCandidate?.info?.author}"`);
                break;
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      console.warn("[Smart Autoplay] SoundCloud autoplay discovery notice:", e);
    }
  }

  if (!foundCandidate) return null;
  let selectedCandidate: Track = foundCandidate;

  // Keep YTM's recommendation identity, then prefer the exact JioSaavn studio
  // recording for playback when its title, artist/version and duration match.
  if (!(selectedCandidate.userData as any)?.isJioSaavn) {
    try {
      const jioMatch = await withTimeout(
        resolveJioSaavnTrack(selectedCandidate.info.title || "", selectedCandidate.info.author || ""),
        4500
      );
      if (jioMatch && sameRecording(
        { title: jioMatch.title, author: jioMatch.artist, duration: jioMatch.duration * 1000 },
        selectedCandidate.info
      )) {
        const jioPlayback = await withTimeout(loadJioSaavnAsLavalinkTrack(
          jioMatch,
          seedTrack.requester,
          [player.node, ...nodesToTry]
        ), 3500);
        if (jioPlayback) {
          selectedCandidate = jioPlayback.track;
          console.log(`[Smart Autoplay] Playing YTM-related recommendation from JioSaavn: "${selectedCandidate.info.title}" by "${selectedCandidate.info.author}"`);
        }
      }
    } catch (e) {
      console.warn("[Smart Autoplay] JioSaavn stream upgrade notice:", e);
    }
  }

  // Prefer matching catalog recordings; search results do not report source bitrate.
  // Skip the YouTube re-search upgrade when:
  //   1. The candidate is already a JioSaavn track (already has 320kbps audio)
  //   2. YouTube playback is known-broken (upgrade would just fail later)
  let studioMasterTrack: Track = selectedCandidate;
  const isJio = Boolean((selectedCandidate as any).userData?.isJioSaavn);
  const hqSearchNode = kasawaNode || milloNode || nodesToTry[0];
  if (!isJio && ytHealthy && hqSearchNode) {
    try {
      const parsedCandidate = parseTrackTitle(selectedCandidate.info.title || "", selectedCandidate.info.author || "");
      const hqQuery = parsedCandidate.fullSearchQuery || `${parsedCandidate.songTitle} ${parsedCandidate.artist}`.trim();
      const hqRes: any = await hqSearchNode.search({
        query: hqQuery,
        source: "ytmsearch",
      }, seedTrack.requester).catch(() => null);

      const masters = rankSearchTracks<any>(hqRes?.tracks || [], parsedCandidate.songTitle)
        .filter(t => isPreferredRadioUpload(t.info) && !restrictedTrackIds.has(t.info.identifier) && sameRecording(t.info, selectedCandidate.info));
      const candidateMaster = masters[0];
      if (candidateMaster && authorConfidence(candidateMaster.info.author) >= authorConfidence(selectedCandidate.info.author)) {
        studioMasterTrack = candidateMaster;
        studioMasterTrack.userData = { ...studioMasterTrack.userData, searchSource: "ytmsearch" };
        console.log(`[Smart Autoplay] Matched catalog recording: "${candidateMaster.info.title}" by "${candidateMaster.info.author}"`);
      }

    } catch (e) {
      console.warn("[Smart Autoplay] Studio master upgrade notice:", e);
    }
  }

  // Do NOT force-migrate the player to a different node here — the player's current
  // healthy node is already streaming fine. Migration only happens in trackError recovery.

  studioMasterTrack.requester = { displayName: "📻 Autoplay Radio" } as any;
  (studioMasterTrack as any).userData = { ...(studioMasterTrack.userData || {}), command: "Autoplay", isAutoplay: true };
  return studioMasterTrack;
}

/**
 * Pre-fetches the next autoplay recommendation in the background while the current track is playing.
 * Resolves metadata ahead of time; the audio node still needs to open the stream.
 */
export async function prefetchAutoplayTrack(player: Player): Promise<void> {
  const isAutoplay = Boolean(player.getData("autoplay") ?? true);
  if (!isAutoplay) return;
  if (player.getData("recovering_track")) return;

  // STRICT USER PRIORITY: If there are ANY user-queued tracks, do not prefetch autoplay!
  const userTracks = player.queue.tracks.filter((t: any) => {
    const isAuto = (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
    return !isAuto;
  });
  if (userTracks.length > 0) return;
  if (player.queue.tracks.length > 0) return;
  if (player.getData("prefetching_autoplay")) return;

  const seed = player.queue.current || player.queue.previous[0];
  if (!seed) return;

  const generation = player.getData("playback_generation");
  player.setData("prefetching_autoplay", true);
  try {
    const track = await findAutoplayRecommendation(player, seed);
    const currentUserTracks = player.queue.tracks.filter((t: any) => {
      const isAuto = (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
      return !isAuto;
    });
    if (track && lavalink.getPlayer(player.guildId) === player && (player.getData("autoplay") ?? true) && !player.getData("recovering_track") && player.getData("playback_generation") === generation && player.queue.current === seed && currentUserTracks.length === 0 && player.queue.tracks.length === 0) {
      await player.queue.add(track);
      console.log(`[Smart Autoplay] Pre-fetched "${track.info.title}" by "${track.info.author}" for zero-buffer gapless transition.`);
    }
  } catch (err) {
    console.warn("[Smart Autoplay] Prefetch note:", err);
  } finally {
    player.setData("prefetching_autoplay", false);
  }
}

/**
 * Removes any pre-fetched autoplay tracks in-place from the queue so user-queued tracks take 100% priority
 */
export function purgeAutoplayTracks(player: Player): void {
  player.setData("playback_generation", Number(player.getData("playback_generation") || 0) + 1);
  for (let i = player.queue.tracks.length - 1; i >= 0; i--) {
    const t = player.queue.tracks[i];
    const isAuto = (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
    if (isAuto) {
      player.queue.tracks.splice(i, 1);
    }
  }
}

export function getMasterNodeConfigs(): LavalinkNodeOptions[] {
  const configs: LavalinkNodeOptions[] = [];
  if (
    config.lavalink.customEnabled && process.env.LAVALINK_HOST
  ) {
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

  if (!config.lavalink.publicFallbacks) return configs;

  // =========================================================================
  // PUBLIC FALLBACK NODES (Kept for reference / backup - uncomment to re-enable)
  // =========================================================================
  /*
  // Priority 1: Kasawa-MasterNode (verified online, supports direct HTTP 320k JioSaavn streaming, YT, Spotify, SoundCloud)
  configs.push(
    {
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
    },
    {
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
    },
    {
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
    }
  );
  */

  return configs;
}

let watchdogInterval: NodeJS.Timeout | null = null;

/**
 * Self-healing watchdog: detects missing or destroyed nodes and automatically recreates & reconnects them
 */
export async function ensureNodesHealthy(): Promise<void> {
  if (!lavalink || !lavalink.nodeManager) return;
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
    const existingNode = lavalink.nodeManager.nodes.get(nodeConfig.id!);
    if (!existingNode) {
      console.log(`[Self-Healing Watchdog] Re-registering destroyed/missing node "${nodeConfig.id}"...`);
      try {
        const newNode = lavalink.nodeManager.createNode(nodeConfig);
        await newNode.connect();
        console.log(`[Self-Healing Watchdog] Node "${nodeConfig.id}" recreated and connected!`);
      } catch (err: any) {
        console.warn(`[Self-Healing Watchdog] Reconnection failed for "${nodeConfig.id}":`, err?.message || err);
      }
    } else if (!existingNode.connected && !existingNode.isNodeReconnecting) {
      console.log(`[Self-Healing Watchdog] Triggering connect for idle disconnected node "${existingNode.id}"...`);
      try {
        await existingNode.connect();
      } catch (err: any) {
        console.warn(`[Self-Healing Watchdog] Failed connecting "${existingNode.id}":`, err?.message || err);
      }
    }
  }
}

export function initLavalink(client: Client) {
  if (config.lavalink.customEnabled && process.env.LAVALINK_HOST && isLoopbackHost(config.lavalink.host)) {
    console.warn('[Lavalink] Custom node uses loopback: Lavalink must run in the same container as this bot. For a separate Pterodactyl server use its reachable allocation; for public nodes only set LAVALINK_CUSTOM_ENABLED=false.');
  }
  if (!getMasterNodeConfigs().length) throw new Error('No Lavalink nodes configured: enable a custom node or public fallbacks.');
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
    // We advance explicitly in trackEnd so loadFailed tracks can attempt a
    // strict JioSaavn recovery before the next playlist item starts.
    autoSkip: false,
    autoMove: true,
    autoSkipOnResolveError: true,
    playerOptions: {
      clientBasedPositionUpdateInterval: 150, // 150ms position accuracy for ultra-smooth timestamps
      defaultSearchPlatform: "ytmsearch", // Prefer YouTube Music catalog search
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
    const detail = reason?.code === 1006
      ? 'Abnormal WebSocket closure (1006); check the preceding transport error and server logs. This code does not prove a ping timeout.'
      : `WebSocket closed (code ${reason?.code ?? 'unknown'}).`;
    console.warn(`[Lavalink] Disconnected from audio node "${node.id}": ${detail}`);
  });

  lavalink.nodeManager.on("error", (node, error) => {
    console.error(`[Lavalink] Node "${node.id}" encountered an error: ${nodeErrorSummary(error)}`);
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
  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(() => {
    try {
      const anyConnected = Array.from(lavalink.nodeManager.nodes.values()).some((n) => n.connected);
      const hasMissingNodes = getMasterNodeConfigs().some((c) => !lavalink.nodeManager.nodes.has(c.id!));
      if (!anyConnected || hasMissingNodes) {
        ensureNodesHealthy().catch(() => {});
      }
    } catch {}
  }, 20000);

  // Dedicated Live Player Ticker (smooth 3.5s updates while playing)
  const liveTickers = new Map<string, NodeJS.Timeout>();

  function startLivePlayerTicker(player: Player) {
    stopLivePlayerTicker(player.guildId);
    let preloadedTrackId: string | null = null;

    const ticker = setInterval(async () => {
      try {
        // ONLY stop the ticker if there is NO current song in the player
        if (!player.queue.current) {
          stopLivePlayerTicker(player.guildId);
          return;
        }

        // If paused or stream not active, skip this tick without killing the timer
        if (player.paused) return;

        // Pause ticker updates during active recovery to prevent UI stutter
        // and reduce Discord API rate-limit pressure during error storms
        if (player.getData("recovering_track")) return;

        // Gapless Preload: When current track has < 12 seconds remaining, pre-resolve next track
        const remaining = (player.queue.current.info.duration || 0) - (player.position || 0);
        if (remaining > 0 && remaining <= 12000 && player.queue.tracks.length > 0) {
          const nextTrack = player.queue.tracks[0];
          if (nextTrack && nextTrack.info.identifier !== preloadedTrackId) {
            preloadedTrackId = nextTrack.info.identifier || null;
            if (typeof (nextTrack as any).resolve === "function") {
              console.log(`[Gapless Preloader] Preloading next track "${nextTrack.info.title}" ahead of transition...`);
              (nextTrack as any).resolve(player).catch(() => {});
            }
          }
        }

        // Verified playback: if a YouTube track has actually streamed past 4 seconds without error,
        // it has genuinely succeeded in playing!
        const currentSource = player.queue.current?.info?.sourceName;
        if (currentSource && /youtube/i.test(currentSource) && (player.position || 0) >= 4000) {
          if (!isYouTubePlaybackHealthy()) {
            console.log(`[YouTube Health] YouTube track "${player.queue.current.info.title}" verified playing at ${player.position}ms. Restoring YouTube health.`);
          }
          recordYouTubePlaybackSuccess();
        }

        await updateActivePlayerMessage(player);

      } catch (err) {
        console.warn("[Ticker Tick Error]:", err);
      }
    }, 4000);
    if (typeof (ticker as any)?.unref === "function") (ticker as any).unref();
    liveTickers.set(player.guildId, ticker);
  }

  function stopLivePlayerTicker(guildId: string) {
    const ticker = liveTickers.get(guildId);
    if (ticker) {
      clearInterval(ticker);
      liveTickers.delete(guildId);
    }
  }

  // Player Events
  // Self-healing: if Lavalink sends playerUpdate while playing and ticker was somehow paused/lost, revive it
  lavalink.on("playerUpdate", (_oldPlayer: any, newPlayer: Player) => {
    if (newPlayer?.queue?.current && !newPlayer.paused && newPlayer.playing) {
      if (!liveTickers.has(newPlayer.guildId)) {
        console.log(`[Player] Revived live ticker for "${newPlayer.queue.current.info.title}"`);
        startLivePlayerTicker(newPlayer);
      }
      const currentSource = newPlayer.queue.current?.info?.sourceName;
      if (currentSource && /youtube/i.test(currentSource) && (newPlayer.position || 0) >= 4000) {
        if (!isYouTubePlaybackHealthy()) {
          console.log(`[YouTube Health] YouTube track "${newPlayer.queue.current.info.title}" verified streaming at ${newPlayer.position}ms. Restoring YouTube health.`);
        }
        recordYouTubePlaybackSuccess();
      }
    }
  });

  const trackStartLocks = new Set<string>();

  lavalink.on("trackStart", async (player: Player, track: Track | null, payload) => {
    const requestedVideoId = (track?.userData as any)?.isJioSaavn ? undefined : (track?.userData as any)?.requestedVideoId;
    const actual = confirmedTrack(lavalink, track, payload);
    if (actual && actual !== track) {
      // An older start event can arrive after a newer play request. Verify the
      // node's live state before changing queue metadata or pausing any audio.
      const generation = player.getData("playback_generation");
      const snapshot = player.queue.current;
      const node = player.node;
      const live = await withTimeout(node.fetchPlayer(player.guildId), 2500).catch(() => null);
      if (!live || !("track" in live) || !live.track || live.track.encoded !== actual.encoded || player.queue.current !== snapshot || player.node !== node || player.getData("playback_generation") !== generation) return;
      console.warn(`[Playback Identity] Node confirmed a different recording than the queue in guild ${player.guildId}; correcting metadata.`);
      player.queue.current = actual;
      track = actual;
    }
    player.setData("track_epoch", Number(player.getData("track_epoch") || 0) + 1);
    player.setData("playback_generation", Number(player.getData("playback_generation") || 0) + 1);

    if (requestedVideoId && actual?.info.identifier !== requestedVideoId) {
      const paused = await player.pause().then(() => true, err => { console.warn("[Playback Identity] Failed to pause mismatched video:", err); return false; });
      if (player.textChannelId) {
        const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
        channel?.send(paused ? "⚠️ The audio node started a different video than the requested link. Playback has been paused. Please retry the link or choose another source." : "⚠️ The audio node started a different video and did not accept the pause request. Use Stop and reconnect before retrying.").then(m => autoDeleteMessage(m, 12000)).catch(() => {});
      }
    }
    if (!player.textChannelId || !track) return;
    const channel = (client.channels.cache.get(player.textChannelId) ||
      await client.channels.fetch(player.textChannelId).catch(() => null)) as TextChannel | null;
    if (!channel || !channel.isTextBased()) return;

    // Concurrency lock per guild to prevent multiple cards being created simultaneously
    if (trackStartLocks.has(player.guildId)) {
      console.log(`[Player] trackStart execution already in-flight for guild ${player.guildId}. Merging.`);
      return;
    }
    trackStartLocks.add(player.guildId);

    try {

      const prevMessageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);
      const activeTrackUri = player.getData("active_track_uri");

      // If the exact same track is already playing and has an active message, just update it in place
      if (prevMessageId && activeTrackUri && activeTrackUri === track.info.uri) {
        console.log(`[Player] Track "${track.info.title}" re-started on same player. Updating existing card.`);
        await updateActivePlayerMessage(player, true);
        startLivePlayerTicker(player);
        return;
      }
      player.setData("active_track_uri", track.info.uri);

      const playerMsgOptions = () => buildPlayerMessage(player);

      // Clean up previous Now Playing card so the new song gets a fresh announcement card at the bottom
      if (prevMessageId) {
        try {
          const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
          if (prevMsg) {
            await prevMsg.delete().catch(() => {});
          }
        } catch {}
      }

      // Sweeper: delete any orphaned bot messages with Now Playing embeds in recent chat to ensure only 1 card exists
      try {
        const recentMsgs = await channel.messages.fetch({ limit: 6 }).catch(() => null);
        const botPlayerCards = recentMsgs?.filter(
          (m) => m.author.id === client.user?.id && m.embeds.some((e) => e.description?.includes("Now playing"))
        );
        if (botPlayerCards && botPlayerCards.size > 0) {
          for (const [, m] of botPlayerCards) {
            await m.delete().catch(() => {});
          }
        }
      } catch {}

      // Always send a fresh, prominent Now Playing card at the bottom of the chat for new songs
      if (!player.queue.current || lavalink.getPlayer(player.guildId) !== player) return;
      const sentMsg = await channel.send(playerMsgOptions());
      activePlayerMessages.set(player.guildId, sentMsg.id);
      playerMessageCache.set(player.guildId, sentMsg);
      player.setData("active_message_id", sentMsg.id);

      // Checkpoint session state to disk
      saveActiveSessions();

      // Maintain loudness normalization if enabled
      if (player.getData("normalized")) {
        applyLoudnessNormalization(player, true).catch(() => {});
      }

      // Start live progress bar updates
      startLivePlayerTicker(player);

      // Auto-maximize and check voice channel bitrate quality
      if (player.voiceChannelId) {
        const voiceChan = channel.guild.channels.cache.get(player.voiceChannelId) as VoiceBasedChannel | undefined;
        if (voiceChan && voiceChan.isVoiceBased()) {
          autoMaximizeVoiceChannelBitrate(voiceChan).catch(() => {});
          const bitrateInfo = getChannelBitrateInfo(voiceChan);
          if (!bitrateInfo.isMaxQuality) {
            channel.send({
              content: bitrateInfo.recommendation,
            }).then((msg) => autoDeleteMessage(msg, 12000)).catch(() => {});
          }
        }
      }
      // Pre-fetch next autoplay recommendation in background only when queue has NO user tracks
      setTimeout(() => {
        const isAutoplay = !player.paused && Boolean(player.getData("autoplay") ?? true);
        const userTracks = player.queue.tracks.filter((t: any) => {
          const isAuto = (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
          return !isAuto;
        });
        if (isAutoplay && userTracks.length === 0 && player.queue.tracks.length === 0) {
          prefetchAutoplayTrack(player).catch(() => {});
        }
      }, 2500);
    } catch (err) {
      console.error("[Lavalink] Failed to send trackStart message:", err);
    } finally {
      trackStartLocks.delete(player.guildId);
    }
  });

  lavalink.on("queueEnd", async (player: Player) => {
    stopLivePlayerTicker(player.guildId);
    if (player.getData("recovering_track")) return;
    const generation = player.getData("playback_generation");
    if (!player.textChannelId) return;
    const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;

    // Smart Autoplay fallback (if queue ran empty before prefetch completed)
    const isAutoplay = Boolean(player.getData("autoplay") ?? true);
    if (isAutoplay && player.queue.previous.length > 0) {
      if (player.queue.tracks.length > 0) return;

      const lastTrack = player.queue.previous[0];
      const recommendedTrack = await findAutoplayRecommendation(player, lastTrack);
      if (recommendedTrack) {
        if (lavalink.getPlayer(player.guildId) !== player || player.queue.current || player.playing || player.queue.tracks.length > 0 || !(player.getData("autoplay") ?? true) || player.getData("playback_generation") !== generation) return;
        await player.queue.add(recommendedTrack);
        await player.play();

        if (channel) {
          channel.send({
            content: `📻 **Autoplay Radio:** Playing **[${recommendedTrack.info.title}](${recommendedTrack.info.uri})** by **${recommendedTrack.info.author}**`,
          }).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => {});
        }
        return;
      }
    }

    if (player.queue.current || player.queue.tracks.length || player.getData("playback_generation") !== generation) return;
    if (channel) {
      const is247 = is247Enabled(player.guildId);
      const prevMessageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);

      const queueFinishedEmbed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle("🎶 Queue Finished")
        .setDescription(
          is247
            ? "✨ All tracks finished playing. Staying **24/7** in voice channel!\n\nUse `/play <song>` or enable `/autoplay` to keep music flowing."
            : "✨ All tracks finished playing. Use `/play <song>` or enable `/autoplay` to keep music flowing!"
        )
        .setFooter({ text: "💎 South Conclave Audiophile Engine" })
        .setTimestamp();

      let finishedMsg: any = null;
      if (prevMessageId) {
        try {
          const prevMsg = channel.messages.cache.get(prevMessageId) || (await channel.messages.fetch(prevMessageId).catch(() => null));
          if (prevMsg) {
            finishedMsg = await prevMsg.edit({ embeds: [queueFinishedEmbed], components: [] });
          } else {
            finishedMsg = await channel.send({ embeds: [queueFinishedEmbed] });
          }
        } catch {
          finishedMsg = await channel.send({ embeds: [queueFinishedEmbed] }).catch(() => null);
        }
      } else {
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

  async function recoverBeforeQueuedNext(player: Player, failedTrack: Track, failedPosition: number): Promise<boolean> {
    if (player.getData("recovering_track")) return false;
    const displacedNext = player.queue.current;
    const stillWaiting = () => lavalink.getPlayer(player.guildId) === player && player.queue.current === displacedNext;
    player.setData("recovering_track", true);
    try {
      const alternateNodes = Array.from(lavalink.nodeManager.nodes.values())
        .filter(n => n.connected && n.id !== player.node.id)
        .sort((a, b) => Number(isNodeHealthy(b.id)) - Number(isNodeHealthy(a.id)));
      const result = await resolveRecoveryTrack(failedTrack, [...alternateNodes, player.node], stillWaiting, player.node.id);
      if (!result?.track || !stillWaiting()) return false;

      const recoveredTrack = result.track;
      const targetNode = result.node;
      if (player.node.id !== targetNode.id) {
        await player.changeNode(targetNode, false);
        if (!stillWaiting()) return false;
      }

      recoveredTrack.requester = failedTrack.requester;
      const recoveredIsJio = Boolean((recoveredTrack.userData as any)?.isJioSaavn);
      recoveredTrack.userData = recoveredIsJio ? {
        command: (failedTrack.userData as any)?.command,
        isAutoplay: (failedTrack.userData as any)?.isAutoplay,
        recoveredFromVideoId: (failedTrack.userData as any)?.requestedVideoId,
        recoveredFromUri: (failedTrack.userData as any)?.requestedUri,
        ...recoveredTrack.userData,
        requestedVideoId: undefined,
        requestedUri: undefined,
        recoveryAttempts: Number((failedTrack.userData as any)?.recoveryAttempts || 0) + 1,
      } : {
        command: (failedTrack.userData as any)?.command,
        isAutoplay: (failedTrack.userData as any)?.isAutoplay,
        requestedVideoId: (failedTrack.userData as any)?.requestedVideoId,
        requestedUri: (failedTrack.userData as any)?.requestedUri,
        ...recoveredTrack.userData,
        recoveryAttempts: Number((failedTrack.userData as any)?.recoveryAttempts || 0) + 1,
      };

      // lavalink-client already shifted to the next queue item. Put it back so
      // the recovered recording plays in the failed song's original position.
      if (displacedNext) player.queue.tracks.unshift(displacedNext);
      player.queue.current = recoveredTrack;
      const position = recoveredTrack.info.isSeekable !== false && !recoveredTrack.info.isStream
        ? Math.min(failedPosition, Math.max(0, recoveredTrack.info.duration - 1000)) : 0;
      await player.play({ clientTrack: recoveredTrack, noReplace: false, position });

      if (player.textChannelId) {
        const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
        const label = recoveredIsJio ? "**JioSaavn**" : "an alternate stream";
        channel?.send(`🔄 **Recovered before advancing the queue** via ${label}: **[${recoveredTrack.info.title}](${recoveredTrack.info.uri})**`).then(msg => autoDeleteMessage(msg, 7000)).catch(() => {});
      }
      return true;
    } catch (err: any) {
      console.warn(`[Queue Recovery] Failed for "${failedTrack.info.title}":`, err?.message || err);
      return false;
    } finally {
      player.setData("recovering_track", false);
    }
  }

  lavalink.on("trackEnd", async (player: Player, track, payload) => {
    console.log(`[Player] trackEnd: "${track?.info.title}" | Reason: ${payload.reason} | Position: ${player.position}ms`);
    if (payload.reason === "replaced") return;

    if (payload.reason === "loadFailed" && track) {
      const pending = player.getData("pending_failed_track") as { track: Track; position: number } | undefined;
      player.setData("pending_failed_track", null);
      const failedTrack = pending && pending.track?.encoded === track.encoded ? pending.track : track;
      const recovered = await recoverBeforeQueuedNext(player, failedTrack, pending?.position || 0);
      if (recovered) return;
    }

    // autoSkip is disabled so that loadFailed can wait for recovery. Continue
    // normal finished/skipped tracks, or advance after recovery was exhausted.
    if (player.queue.current) {
      await player.play({ noReplace: true }).catch((err: any) => {
        console.warn("[Queue Advance] Failed to start next track:", err?.message || err);
      });
    }
    if (!player.queue.current) {
      stopLivePlayerTicker(player.guildId);
    }
  });

  lavalink.on("playerDestroy", (player: Player) => {
    stopLivePlayerTicker(player.guildId);
    clearUpdaterState(player.guildId);
    activePlayerMessages.delete(player.guildId);
    playerMessageCache.delete(player.guildId);
    clearGuildSession(player.guildId);
  });

  lavalink.on("trackStuck", async (player: Player, track, payload) => {
    console.warn(`[Lavalink] Audio stream stuck for "${track?.info.title}" (${payload.thresholdMs}ms threshold). Handling recovery...`);

    if (player.node?.id) markNodeDegraded(player.node.id, 60000);

    // lavalink-client shifts the queue only after this listener returns. Since
    // autoSkip is disabled, wait for that exact shift, then recover the failed
    // recording or explicitly start the expected next item.
    const expectedNext = player.queue?.tracks?.[0];
    const failedPosition = player.position || 0;
    if (!track) return;

    if (expectedNext) {
      void (async () => {
        for (let attempt = 0; attempt < 20 && player.queue.current === track; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (lavalink.getPlayer(player.guildId) !== player || player.queue.current !== expectedNext) return;

        const recovered = await recoverBeforeQueuedNext(player, track, failedPosition);
        if (!recovered && player.queue.current === expectedNext) {
          await player.play({ noReplace: true }).catch((err: any) => {
            console.warn("[Queue Advance] Failed to start next track after a stuck stream:", err?.message || err);
          });
        }
      })().catch((err: any) => {
        console.warn("[Queue Recovery] Stuck-track handling failed:", err?.message || err);
      });
    }

  });

  lavalink.on("trackError", async (player: Player, track, payload) => {
    if (payload?.track?.encoded && track?.encoded && payload.track.encoded !== track.encoded) return;
    const errorMsg = payload?.exception?.message || JSON.stringify(payload);
    console.error(`[Lavalink] Error playing "${track?.info.title}":`, errorMsg);

    const isNodeNetworkDown =
      errorMsg.includes("Unexpected token '<'") ||
      errorMsg.includes("<html>") ||
      errorMsg.includes("502") ||
      errorMsg.includes("503") ||
      errorMsg.includes("ConnectTimeoutError") ||
      errorMsg.includes("fetch failed");

    // Only mark node degraded for genuine network outages, NOT track-specific video restrictions!
    if (isNodeNetworkDown && player.node?.id) {
      console.warn(`[Node Circuit Breaker] Node "${player.node?.id}" network drop. Marking degraded for 60s.`);
      markNodeDegraded(player.node.id, 60000);
    }

    // Track YouTube playback health: if a YouTube source track failed, record it
    const isYouTubeSource = track?.info?.sourceName && /youtube/i.test(track.info.sourceName);
    if (isYouTubeSource && !isNodeNetworkDown) {
      recordYouTubePlaybackFailure();
      if (!isYouTubePlaybackHealthy()) {
        console.warn(`[YouTube Health] YouTube playback unhealthy (${ytPlaybackFailures.length} recent failures). Future autoplay will prefer JioSaavn.`);
      }
    }

    if (!track || player.getData("recovering_track")) return;
    const failedPosition = player.position || 0;
    const generation = player.getData("playback_generation");
    const recoveryIsCurrent = () => lavalink.getPlayer(player.guildId) === player && player.getData("playback_generation") === generation && (!player.queue.current || player.queue.current === track);

    // Cache the failed track ID so we never retry or loop on a broken YouTube video
    if (track.info.identifier) {
      restrictedTrackIds.add(track.info.identifier);
    }

    // With queued music, trackEnd will receive loadFailed after lavalink-client
    // shifts to the next item. Save this track so it can be recovered first.
    const recoverBeforeAdvance = player.queue.tracks.length > 0;
    if (recoverBeforeAdvance) {
      player.setData("pending_failed_track", { track, position: failedPosition });
    }

    // If single track loop is active, disable it to prevent an infinite error loop on this failing song
    if (player.repeatMode === "track") {
      console.warn(`[Universal Recovery] Disabling track loop because "${track?.info.title}" failed to stream.`);
      await player.setRepeatMode("off").catch(() => {});
    }

    if (recoverBeforeAdvance) return;

    const rawTitle = track.info.title || "";
    const recoveryAttempts = Number((track.userData as any)?.recoveryAttempts || 0) + 1;
    player.setData("recovery_attempts", recoveryAttempts);

    // Circuit breaker: prevent infinite retry loops if all sources fail
    if (recoveryAttempts > 2) {
      console.warn(`[Universal Recovery] Max recovery attempts (2) reached for "${rawTitle}". Skipping track.`);
      player.setData("recovery_attempts", 0);
      player.setData("recovering_track", false);

      if (player.textChannelId) {
        const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
        channel?.send(`⚠️ **Playback unavailable:** Recovery attempts for **${rawTitle}** were exhausted.`).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => {});
      }
      return;
    }

    // Universal Auto-Recovery for blocked/age-gated/login-required/broken streams
    if (!player.getData("recovering_track")) {
      try {
        player.setData("recovering_track", true);

        const alternateNodes = Array.from(lavalink.nodeManager.nodes.values())
          .filter(n => n.connected && n.id !== player.node.id)
          .sort((a, b) => Number(isNodeHealthy(b.id)) - Number(isNodeHealthy(a.id)));
        const result = await resolveRecoveryTrack(track, [...alternateNodes, player.node], recoveryIsCurrent, player.node.id);
        const recoveredTrack = result?.track;
        const targetNode = result?.node;

        if (!recoveryIsCurrent()) return;
        if (recoveredTrack) {
          // If the recovery track was found on another node, migrate player
          if (player.node.id !== targetNode.id) {
            console.log(`[Universal Recovery] Migrating player from ${player.node.id} to ${targetNode.id}...`);
            try {
              await player.changeNode(targetNode, false);
            } catch (err: any) {
              console.warn("[Universal Recovery] changeNode error:", err?.message || err);
              return;
            }
          }

          recoveredTrack.requester = track.requester;
          if (!recoveryIsCurrent()) return;
          const recoveredIsJio = Boolean((recoveredTrack.userData as any)?.isJioSaavn);
          recoveredTrack.userData = recoveredIsJio ? {
            command: (track.userData as any)?.command,
            isAutoplay: (track.userData as any)?.isAutoplay,
            recoveredFromVideoId: (track.userData as any)?.requestedVideoId,
            recoveredFromUri: (track.userData as any)?.requestedUri,
            ...recoveredTrack.userData,
            requestedVideoId: undefined,
            requestedUri: undefined,
            recoveryAttempts,
          } : {
            command: (track.userData as any)?.command,
            isAutoplay: (track.userData as any)?.isAutoplay,
            requestedVideoId: (track.userData as any)?.requestedVideoId,
            requestedUri: (track.userData as any)?.requestedUri,
            ...recoveredTrack.userData,
            recoveryAttempts,
          };
          try {
            const position = recoveredTrack.info.isSeekable !== false && !recoveredTrack.info.isStream
              ? Math.min(failedPosition, Math.max(0, recoveredTrack.info.duration - 1000)) : 0;
            await player.play({ clientTrack: recoveredTrack, noReplace: false, position });
          } catch (playErr: any) {
            if (player.getData("playback_generation") === generation && player.queue.current === recoveredTrack) player.queue.current = track as Track;
            console.warn("[Universal Recovery] play error:", playErr?.message || playErr);
            return;
          }

          if (player.textChannelId) {
            const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
            const isJio = Boolean((recoveredTrack as any).userData?.isJioSaavn);
            const streamLabel = isJio ? "**JioSaavn**" : "an alternate stream";
            channel?.send(`🔄 **Retrying playback** via ${streamLabel}: **[${recoveredTrack.info.title}](${recoveredTrack.info.uri})**`).then((msg) => autoDeleteMessage(msg, 7000)).catch(() => {});
          }

          return;
        }
      } catch (err) {
        console.error("[Universal Recovery Failed]:", err);
      } finally {
        player.setData("recovering_track", false);
      }
    }

    if (!recoveryIsCurrent() || !player.textChannelId) return;
    const channel = client.channels.cache.get(player.textChannelId) as TextChannel | undefined;
    if (channel) {
      channel.send((track.userData as any)?.requestedVideoId
        ? "⚠️ The exact YouTube video is unavailable on the audio nodes. Try `/play` with its song and artist, or `/jio` for a catalog recording."
        : `⚠️ Playback failed for **${track.info.title}**. No matching recording could be recovered. Try again later or choose another source.`).then((msg) => autoDeleteMessage(msg, 8000)).catch(() => {});
    }
  });

  return lavalink;
}

export function getBestNode(): string | undefined {
  if (config.lavalink.customEnabled && process.env.LAVALINK_HOST) {
    const custom = lavalink.nodeManager.nodes.get("Primary-CustomNode");
    if (custom?.connected && isNodeHealthy("Primary-CustomNode")) return "Primary-CustomNode";
  }

  // Score every healthy connected node by real-time load metrics.
  // Lower score = less load = better for new streams.
  const candidates = Array.from(lavalink.nodeManager.nodes.values()).filter(
    (n) => n.connected && isNodeHealthy(n.id)
  );

  if (candidates.length === 0) {
    // All healthy nodes gone — fall back to any connected node
    const fallback = Array.from(lavalink.nodeManager.nodes.values()).find(
      (n) => n.connected
    );
    return fallback?.id;
  }

  // Node load score (lower = better):
  //   - Frame deficit contributes heavily (each deficit frame = jitter/speed-up for listeners)
  //   - Playing player count shows how loaded the node is
  //   - CPU load adds secondary pressure signal
  //   - Static priority bonus: Jirayu=0, Trinium=10, Millo=30 (tiebreaker)
  const FRAME_DEFICIT_WEIGHT = 0.5;   // per deficit frame
  const PLAYER_COUNT_WEIGHT  = 5;     // per active playing stream
  const CPU_WEIGHT           = 200;   // per 1.0 (100%) CPU load
  const JITTER_THRESHOLD     = 50;    // deficit frames below this = negligible

  const scored = candidates.map((node) => {
    const stats = (node as any).stats;
    const deficit      = Math.max(0, (stats?.frameStats?.deficit ?? 0) - JITTER_THRESHOLD);
    const playing      = stats?.playingPlayers ?? 0;
    const cpu          = stats?.cpu?.lavalinkLoad ?? 0;

    // Priority bonus (lower = preferred when load is equal)
    let priorityBonus = 50;
    if (node.id === "Kasawa-MasterNode") priorityBonus = 0; // Primary master node (direct HTTP 320k JioSaavn + YT/SoundCloud)
    if (node.id === "Serenetia-AuxNode") priorityBonus = 10;
    if (node.id === "Millo-BackupNode") priorityBonus = 50;

    const score = (deficit * FRAME_DEFICIT_WEIGHT) +
                  (playing * PLAYER_COUNT_WEIGHT)  +
                  (cpu     * CPU_WEIGHT)            +
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
export async function getOrCreatePlayer(interaction: ChatInputCommandInteraction): Promise<{
  player: Player | null;
  error?: string;
}> {
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

  let player = lavalink.getPlayer(interaction.guildId!);
  if (!player) {
    const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
    if (connectedNodes.length === 0) {
      // Trigger self-healing watchdog immediately
      ensureNodesHealthy().catch(() => {});
      return {
        player: null,
        error: "⚠️ **Audio servers are reconnecting:** The audio nodes temporarily disconnected after a network drop. Please wait ~5 seconds and try `/play` again!",
      };
    }

    const targetNode = getBestNode();
    console.log(`[Player] Creating player for guild ${interaction.guildId} in voice channel ${voiceChannel.name} (${voiceChannel.id}) on node "${targetNode || "default"}"`);
    try {
      player = lavalink.createPlayer({
        guildId: interaction.guildId!,
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
    } catch (err: any) {
      console.error("[Player Creation Error]:", err?.message || err);
      ensureNodesHealthy().catch(() => {});
      return {
        player: null,
        error: "⚠️ **Audio server initializing:** Reconnecting to audio nodes. Please try again in 5 seconds!",
      };
    }
  } else if (!isNodeHealthy(player.node?.id)) {
    // If existing player was assigned to a degraded node, migrate to best healthy node
    const bestNodeId = getBestNode();
    if (bestNodeId && bestNodeId !== player.node?.id) {
      const betterNode = lavalink.nodeManager.nodes.get(bestNodeId);
      if (betterNode?.connected) {
        console.log(`[Player] Migrating player from degraded "${player.node?.id}" to healthy "${betterNode.id}"...`);
        await player.changeNode(betterNode, false).catch(() => {});
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

interface MessageUpdaterState {
  inFlight: boolean;
  pending: boolean;
  lastEditTime: number;
  timer?: NodeJS.Timeout;
}

const updaterStates = new Map<string, MessageUpdaterState>();

export function clearUpdaterState(guildId: string): void {
  const s = updaterStates.get(guildId);
  if (s?.timer) clearTimeout(s.timer);
  updaterStates.delete(guildId);
}

/**
 * Updates the active Now Playing message in the text channel with rate-limiting & queuing protection
 */
export async function updateActivePlayerMessage(player: Player, immediate: boolean = false): Promise<void> {
  if (!player.textChannelId || lavalink.getPlayer(player.guildId) !== player) return;

  let state = updaterStates.get(player.guildId);
  if (!state) {
    state = { inFlight: false, pending: false, lastEditTime: 0 };
    updaterStates.set(player.guildId, state);
  }

  const now = Date.now();
  const MIN_INTERVAL = 2200; // Space edits to reduce Discord rate-limit pressure.
  const elapsed = now - state.lastEditTime;

  if (state.inFlight) {
    state.pending = true;
    return;
  }

  if (!immediate && elapsed < MIN_INTERVAL) {
    state.pending = true;
    if (!state.timer) {
      state.timer = setTimeout(async () => {
        state!.timer = undefined;
        if (state!.pending) {
          state!.pending = false;
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
    await performPlayerMessageEdit(player);
    state.lastEditTime = Date.now();
  } catch (err: any) {
    if (err?.message !== "Edit timeout") {
      console.warn(`[Message Updater] Edit error on guild ${player.guildId}:`, err?.message || err);
    }
  } finally {
    state.inFlight = false;
    if (state.pending && lavalink.getPlayer(player.guildId) === player) {
      state.pending = false;
      state.timer = setTimeout(() => {
        state!.timer = undefined;
        updateActivePlayerMessage(player);
      }, MIN_INTERVAL);
    }
  }
}

async function performPlayerMessageEdit(player: Player) {
  if (!player.textChannelId) return;
  let messageId = activePlayerMessages.get(player.guildId) || (player.getData("active_message_id") as string | undefined);

  const channel = (discordClient?.channels.cache.get(player.textChannelId) ||
    await discordClient?.channels.fetch(player.textChannelId).catch(() => null)) as TextChannel | null;
  if (!channel || !channel.isTextBased()) return;

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
    } catch {}
  }

  if (!messageId) return;

  try {
    let msg: Message<any> | null = playerMessageCache.get(player.guildId) || channel.messages.cache.get(messageId) || null;
    if (!msg) {
      msg = await channel.messages.fetch(messageId).catch(() => null);
    }

    if (msg && lavalink.getPlayer(player.guildId) === player && activePlayerMessages.get(player.guildId) === messageId) {
      const editedMsg = await msg.edit(buildPlayerMessage(player));
      playerMessageCache.set(player.guildId, editedMsg);
    } else {
      activePlayerMessages.delete(player.guildId);
      playerMessageCache.delete(player.guildId);
      player.setData("active_message_id", null);
    }
  } catch (err: any) {
    if (err.code === 10008) {
      // 10008: Unknown Message (deleted by user or mod)
      activePlayerMessages.delete(player.guildId);
      playerMessageCache.delete(player.guildId);
      player.setData("active_message_id", null);
    } else if (err.status === 429) {
      console.warn(`[Message Updater] Discord 429 rate limit on guild ${player.guildId}. Backing off gracefully.`);
    }
  }
}

/**
 * Voice Gate: Validates that the interacting user is currently in the same voice channel as the bot
 */
export async function validateVoiceGate(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction,
  player: Player
): Promise<{ allowed: boolean; error?: string }> {
  const guild = interaction.guild || (interaction.guildId ? interaction.client.guilds.cache.get(interaction.guildId) || await interaction.client.guilds.fetch(interaction.guildId).catch(() => null) : null);
  if (!guild) {
    return { allowed: false, error: "❌ This action can only be used inside a server!" };
  }

  // Fast in-memory resolution of user voice channel without network latency
  const memberVoiceChannelId =
    (interaction.member as any)?.voice?.channelId ||
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

/** Pause/resume without temporary volume writes racing with user volume changes. */
export async function smoothFadePause(player: Player): Promise<void> {
  await player.pause();
}

export async function smoothFadeResume(player: Player): Promise<void> {
  await player.resume();
}
