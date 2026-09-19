import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getBestNode, getOrCreatePlayer, isNodeHealthy, lavalink, markNodeDegraded, purgeAutoplayTracks, restrictedTrackIds, updateActivePlayerMessage } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { getFavorites } from "../utils/favorites.js";
import { formatDuration, getSourceInfo, getTrackRelevanceScore, isRelevantTrack } from "../utils/formatters.js";
import { getPlaylist, getUserPlaylists } from "../utils/playlists.js";
import { getMusicSuggestions } from "../utils/suggestions.js";
import { isJioSaavnUrl, loadJioSaavnAsLavalinkTrack, resolveJioSaavnTrack, resolveJioSaavnUrl } from "../services/jiosaavn.js";

async function resolveSpotifyTrack(url: string): Promise<string | null> {
  try {
    const cleanUrl = url.split("?")[0];
    const resp = await fetch(cleanUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (resp.ok) {
      const html = await resp.text();
      const match = html.match(/<title>(.*?) - song (?:and lyrics )?by (.*?) \| Spotify<\/title>/i);
      if (match && match[1] && match[2]) {
        console.log(`[Spotify Resolver] Resolved "${cleanUrl}" -> "${match[1]} ${match[2]}"`);
        return `${match[1]} ${match[2]}`.trim();
      }
    }
    const oembedResp = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(cleanUrl)}`);
    if (oembedResp.ok) {
      const data = (await oembedResp.json()) as { title?: string; author_name?: string };
      if (data.title) {
        return `${data.title} ${data.author_name || ""}`.trim();
      }
    }
  } catch (e) {
    console.warn("[Spotify Resolver] Error:", e);
  }
  return null;
}

export async function resolveTrackQuery(rawQuery: string): Promise<{ query: string; isUrl: boolean }> {
  let trimmed = rawQuery.trim();

  // If it's a YouTube watch URL with an auto-generated mix (&list=RD... or &list=UL...), strip the mix list param so it only plays the selected track
  if (trimmed.includes("youtube.com/watch") && trimmed.includes("v=")) {
    try {
      const urlObj = new URL(trimmed);
      const listParam = urlObj.searchParams.get("list");
      if (listParam && !listParam.startsWith("PL")) {
        urlObj.searchParams.delete("list");
        urlObj.searchParams.delete("index");
        trimmed = urlObj.toString();
        console.log(`[Play] Cleaned YouTube mix playlist parameter -> "${trimmed}"`);
      }
    } catch (e) {
      // Ignore URL parse error
    }
  }

  // If Spotify track link: resolve track title & artist for 100% stable YouTube Music HQ audio stream
  if (/^https?:\/\/open\.spotify\.com\/track\//i.test(trimmed)) {
    const resolved = await resolveSpotifyTrack(trimmed);
    if (resolved) {
      return { query: resolved, isUrl: false };
    }
  }

  const isUrl = /^https?:\/\//i.test(trimmed);
  return { query: trimmed, isUrl };
}

/**
 * Smart Multi-Tier Audio Search
 * 1. Resolves Spotify / Apple Music / JioSaavn via node search
 * 2. Tries YouTube Music (256k HQ) across available cluster nodes
 * 3. Tries SoundCloud (purity, no YouTube login wall)
 * 4. Tries clean YouTube audio streams (filtering out video/age-gated tags)
 */
export async function smartSearch(
  player: any,
  query: string,
  isUrl: boolean,
  user: any
) {
  if (isUrl) {
    // 0. Native JioSaavn URL resolution (song, album, playlist)
    if (isJioSaavnUrl(query)) {
      try {
        const jioResult = await resolveJioSaavnUrl(query);
        if (jioResult) {
          const candidateNodes = [
            ...(player.node?.connected ? [player.node] : []),
            ...Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected && n.id !== player.node?.id),
          ];
          if (jioResult.type === "track") {
            const converted = await loadJioSaavnAsLavalinkTrack(jioResult.track, user, candidateNodes);
            if (converted) {
              if (player.node && player.node.id !== converted.node.id && !player.playing) {
                player.changeNode(converted.node, false).catch(() => {});
              }
              return { loadType: "track", tracks: [converted.track] };
            }
          } else if (jioResult.type === "playlist") {
            const convertedTracks: any[] = [];
            for (const t of jioResult.tracks) {
              const conv = await loadJioSaavnAsLavalinkTrack(t, user, candidateNodes);
              if (conv) convertedTracks.push(conv.track);
            }
            if (convertedTracks.length > 0) {
              return {
                loadType: "playlist",
                playlist: {
                  name: jioResult.title,
                  duration: jioResult.tracks.reduce((acc: number, t: any) => acc + (t.duration * 1000), 0),
                  thumbnail: jioResult.tracks[0]?.artworkUrl,
                },
                tracks: convertedTracks,
              };
            }
          }
        }
      } catch (e) {
        console.warn("[SmartSearch] JioSaavn URL resolution notice:", e);
      }
    }

    // 1. Try resolving on current player node if healthy
    if (player.node?.connected && isNodeHealthy(player.node.id)) {
      try {
        const directRes = await player.search({ query }, user);
        if (directRes?.tracks?.length && directRes.loadType !== "empty" && directRes.loadType !== "error") {
          return directRes;
        }
      } catch {}
    }

    // 2. Try resolving across healthy alternate nodes (Kasawa, Millo, Serenetia)
    const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected);
    const healthyOthers = connectedNodes.filter((n: any) => n.id !== player.node?.id && isNodeHealthy(n.id));
    // Prioritize Kasawa (supports direct HTTP + streaming) and Serenetia
    healthyOthers.sort((a: any, b: any) => {
      if (a.id === "Kasawa-MasterNode") return -1;
      if (b.id === "Kasawa-MasterNode") return 1;
      if (a.id === "Serenetia-AuxNode") return -1;
      if (b.id === "Serenetia-AuxNode") return 1;
      return 0;
    });

    for (const node of healthyOthers) {
      try {
        const nodeRes = await node.search({ query }, user);
        if (nodeRes?.tracks?.length && nodeRes.loadType !== "empty" && nodeRes.loadType !== "error") {
          console.log(`[SmartSearch] URL resolved on healthy node "${node.id}". Migrating player to stream...`);
          await player.changeNode(node, false).catch(() => {});
          return nodeRes;
        }
      } catch {}
    }

    // 3. Fallback: try any remaining connected node
    const remaining = connectedNodes.filter((n: any) => n.id !== player.node?.id && !healthyOthers.includes(n));
    for (const node of remaining) {
      try {
        const nodeRes = await node.search({ query }, user);
        if (nodeRes?.tracks?.length && nodeRes.loadType !== "empty" && nodeRes.loadType !== "error") {
          await player.changeNode(node, false).catch(() => {});
          return nodeRes;
        }
      } catch {}
    }
    return null;
  }

  const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter(
    (n: any) => n.connected && !n.id.includes("Custom")
  );
  const healthyNodes = connectedNodes.filter((n: any) => isNodeHealthy(n.id));
  const kasawaNode = healthyNodes.find((n: any) => n.id === "Kasawa-MasterNode");
  const milloNode = healthyNodes.find((n: any) => n.id === "Millo-BackupNode");
  const serenetiaNode = healthyNodes.find((n: any) => n.id === "Serenetia-AuxNode");
  const otherHealthy = healthyNodes.filter((n: any) => n.id !== "Kasawa-MasterNode" && n.id !== "Millo-BackupNode" && n.id !== "Serenetia-AuxNode");
  const degradedList = connectedNodes.filter((n: any) => !isNodeHealthy(n.id));

  // Prioritize Kasawa, Millo, Serenetia
  const playerNodeIfHealthy = (player.node?.connected && isNodeHealthy(player.node.id)) ? [player.node] : [];
  const nodesToTry = healthyNodes.length > 0 ? [
    ...playerNodeIfHealthy,
    ...(kasawaNode && kasawaNode.id !== player.node?.id ? [kasawaNode] : []),
    ...(milloNode && milloNode.id !== player.node?.id ? [milloNode] : []),
    ...(serenetiaNode && serenetiaNode.id !== player.node?.id ? [serenetiaNode] : []),
    ...otherHealthy.filter((n: any) => n.id !== player.node?.id),
  ] : degradedList;

  // Helper to ensure player is assigned to the healthy resolving node
  const syncPlayerNode = (targetNode: any) => {
    if (player.node && player.node.id !== targetNode.id && (!player.node.connected || !isNodeHealthy(player.node.id))) {
      console.log(`[SmartSearch] Migrating player from degraded ${player.node.id} to healthy search node ${targetNode.id}...`);
      player.changeNode(targetNode, false).catch(() => {});
    }
  };

  const executeSearchWithTimeout = async (node: any, searchOpts: any, timeoutMs: number = 3500) => {
    const searchPromise = node.search(searchOpts, user);
    const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    return Promise.race([searchPromise, timeoutPromise]);
  };

  const handleSearchError = (node: any, e: any, label: string) => {
    const errMsg = e?.message || String(e);
    if (
      errMsg.includes("Unexpected token '<'") ||
      errMsg.includes("<html>") ||
      errMsg.includes("502") ||
      errMsg.includes("503") ||
      errMsg.includes("403") ||
      errMsg.includes("All clients failed") ||
      errMsg.includes("requires sign-in") ||
      errMsg.includes("This network flagged") ||
      errMsg.includes("ConnectTimeoutError") ||
      errMsg.includes("fetch failed") ||
      errMsg.includes("timeout")
    ) {
      markNodeDegraded(node.id);
    }
    console.warn(`[SmartSearch] ${label} on "${node.id}" failed:`, errMsg);
  };

  let bestCandidate: any = null;
  let bestScore = 0;

  const updateCandidate = (res: any, node: any, viable: any[]) => {
    for (const t of viable) {
      const titleScore = getTrackRelevanceScore(t.info.title, query);
      if (titleScore > bestScore) {
        bestScore = titleScore;
        bestCandidate = { res, node, tracks: [t, ...viable.filter((x: any) => x !== t)] };
      }
    }
  };

  // 1. Try YouTube Music (ytmsearch) across connected healthy nodes
  for (const node of nodesToTry) {
    try {
      const res: any = await executeSearchWithTimeout(node, { query, source: "ytmsearch" });
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier));
        if (viable.length > 0) {
          updateCandidate(res, node, viable);
          const relevant = viable.filter((t: any) => isRelevantTrack(t.info.title, query));
          if (relevant.length > 0) {
            syncPlayerNode(node);
            console.log(`[SmartSearch] Found "${relevant[0].info.title}" via ytmsearch on node "${node.id}"`);
            return { ...res, tracks: relevant };
          }
        }
      }
    } catch (e: any) {
      handleSearchError(node, e, "ytmsearch");
    }
  }

  // 2. Try YouTube search appending "audio" (favors authentic studio tracks over age-gated music videos)
  for (const node of nodesToTry) {
    try {
      const res: any = await executeSearchWithTimeout(node, { query: `${query} audio`, source: "ytsearch" });
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier));
        if (viable.length > 0) {
          updateCandidate(res, node, viable);
          const relevant = viable.filter((t: any) => isRelevantTrack(t.info.title, query));
          if (relevant.length > 0) {
            syncPlayerNode(node);
            console.log(`[SmartSearch] Found "${relevant[0].info.title}" via ytsearch (audio) on node "${node.id}"`);
            return { ...res, tracks: relevant };
          }
        }
      }
    } catch (e: any) {
      handleSearchError(node, e, "ytsearch (audio)");
    }
  }

  // 3. Try SoundCloud search (scsearch) - ZERO YouTube login walls, fast & unrestricted, verified relevance
  for (const node of nodesToTry) {
    try {
      const res: any = await executeSearchWithTimeout(node, { query, source: "scsearch" });
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier));
        if (viable.length > 0) {
          updateCandidate(res, node, viable);
          const relevant = viable.filter((t: any) => isRelevantTrack(t.info.title, query));
          if (relevant.length > 0) {
            syncPlayerNode(node);
            console.log(`[SmartSearch] Found "${relevant[0].info.title}" via scsearch on node "${node.id}"`);
            return { ...res, tracks: relevant };
          }
        }
      }
    } catch (e: any) {
      handleSearchError(node, e, "scsearch");
    }
  }

  // 4. Return highest scoring candidate if it passes reasonable relevance threshold (>= 0.45)
  if (bestCandidate && bestScore >= 0.45) {
    syncPlayerNode(bestCandidate.node);
    console.log(`[SmartSearch] Returning best fuzzy candidate "${bestCandidate.tracks[0].info.title}" (score: ${bestScore.toFixed(2)}) on node "${bestCandidate.node.id}"`);
    return { ...bestCandidate.res, tracks: bestCandidate.tracks };
  }

  // 5. Ultimate Fallback: Try JioSaavn 320 kbps Studio Master if global providers found no match
  try {
    const jioTrack = await resolveJioSaavnTrack(query);
    if (jioTrack) {
      const candidateNodes = [
        ...(player.node?.connected ? [player.node] : []),
        ...Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected && n.id !== player.node?.id),
      ];
      const converted = await loadJioSaavnAsLavalinkTrack(jioTrack, user, candidateNodes);
      if (converted) {
        syncPlayerNode(converted.node);
        converted.track.userData = {
          ...(converted.track.userData || {}),
          command: "/play",
        };
        console.log(`[SmartSearch] Fallback resolved "${converted.track.info.title}" via JioSaavn 320kbps Studio Master on node "${converted.node.id}"`);
        return { loadType: "track", tracks: [converted.track] };
      }
    }
  } catch (e: any) {
    console.warn("[SmartSearch] JioSaavn resolution notice:", e?.message || e);
  }

  return null;
}

export const playCommand = {
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play high-quality audio from Spotify, Apple Music, YouTube Music, JioSaavn, or search")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song name, artist, or URL (Spotify, Apple Music, YouTube Music, JioSaavn, SoundCloud)")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focusedValue = interaction.options.getFocused();
    const trimmed = (focusedValue || "").trim();
    const userId = interaction.user.id;

    // Direct URLs don't need autocomplete
    if (/^https?:\/\//i.test(trimmed)) {
      return interaction.respond([]).catch(() => {});
    }

    try {
      const suggestions = await getMusicSuggestions(
        trimmed,
        getFavorites(userId),
        getUserPlaylists(userId),
        interaction.user.username
      );
      await interaction.respond(suggestions).catch(() => {});
    } catch (e: any) {
      if (e?.code === 10062 || e?.rawError?.code === 10062) return;
      await interaction.respond([]).catch(() => {});
    }
  },

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const { player, error } = await getOrCreatePlayer(interaction);
    if (error || !player) {
      await interaction.editReply(error || "❌ Failed to connect to voice channel.");
      return;
    }

    const rawQuery = interaction.options.getString("query", true);
    console.log(`[Play Command] User: "${interaction.user.tag}" (${interaction.user.id}) in "${interaction.guild?.name}" | Query: "${rawQuery}"`);

    // Handle custom playlist selected from autocomplete suggestions
    if (rawQuery.startsWith("playlist:")) {
      const playlistName = rawQuery.replace(/^playlist:/i, "").trim();
      const customPlaylist = getPlaylist(interaction.user.id, playlistName);
      if (customPlaylist && customPlaylist.tracks.length > 0) {
        // Purge any pre-fetched autoplay tracks so user's playlist takes 100% priority
        purgeAutoplayTracks(player);

        let queuedCount = 0;
        let firstTrackStarted = false;
        const BATCH_SIZE = 5;
        for (let i = 0; i < customPlaylist.tracks.length; i += BATCH_SIZE) {
          const batch = customPlaylist.tracks.slice(i, i + BATCH_SIZE);
          const resolved = await Promise.all(
            batch.map(async (t) => {
              try {
                let trackRes = await player.search({ query: t.uri }, interaction.user);
                if (!trackRes?.tracks?.length) {
                  trackRes = await smartSearch(player, `${t.title} ${t.author}`, false, interaction.user);
                }
                if (trackRes?.tracks?.length) {
                  const trk = trackRes.tracks[0];
                  trk.requester = interaction.user;
                  trk.userData = { ...(trk.userData || {}), command: "/play" };
                  return trk;
                }
              } catch {}
              return null;
            })
          );

          for (const trk of resolved) {
            if (trk) {
              await player.queue.add(trk);
              queuedCount++;
              if (!firstTrackStarted && !player.playing && !player.paused) {
                firstTrackStarted = true;
                await player.play();
              }
            }
          }
        }

        if (queuedCount > 0) {
          if (!firstTrackStarted && !player.playing && !player.paused) await player.play();
          else await updateActivePlayerMessage(player);
          await interaction.editReply(`🎶 Queued **${queuedCount}** songs from playlist **${customPlaylist.name}**!`);
          autoDeleteReply(interaction, 10000);
          return;
        }
      }
    }

    // Handle direct JioSaavn URL (Song, Album, or Playlist)
    if (isJioSaavnUrl(rawQuery)) {
      const jioResult = await resolveJioSaavnUrl(rawQuery);
      if (jioResult) {
        const candidateNodes = [
          ...(player.node?.connected ? [player.node] : []),
          ...Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected && n.id !== player.node?.id),
        ];

        if (jioResult.type === "track") {
          const converted = await loadJioSaavnAsLavalinkTrack(jioResult.track, interaction.user, candidateNodes);
          if (converted) {
            if (player.node && player.node.id !== converted.node.id && !player.playing) {
              await player.changeNode(converted.node, false).catch(() => {});
            }
            const track = converted.track;
            track.userData = { ...(track.userData || {}), command: "/play" };
            purgeAutoplayTracks(player);
            await player.queue.add(track);
            if (!player.playing && !player.paused) {
              await player.play();
              await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}** [💎 JioSaavn 320 kbps AAC]`);
              autoDeleteReply(interaction, 10000);
            } else {
              await updateActivePlayerMessage(player);
              const source = getSourceInfo(track.info.sourceName, track.info.uri, track.userData);
              const position = player.queue.tracks.length;
              const embed = new EmbedBuilder()
                .setColor(source.color)
                .setTitle("🎶 Added to Queue")
                .setDescription(`**[${track.info.title}](${track.info.uri})**`)
                .addFields([
                  { name: "Artist", value: track.info.author || "Unknown Artist", inline: true },
                  { name: "Duration", value: formatDuration(track.info.duration || 0), inline: true },
                  { name: "Position in Queue", value: `#${position}`, inline: true },
                  { name: "Source Fidelity", value: source.badge, inline: true },
                ]);
              if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);
              await interaction.editReply({ embeds: [embed] });
              autoDeleteReply(interaction, 10000);
            }
            return;
          }
        } else if (jioResult.type === "playlist") {
          purgeAutoplayTracks(player);
          let queuedCount = 0;
          let firstTrackStarted = false;
          const BATCH_SIZE = 5;

          for (let i = 0; i < jioResult.tracks.length; i += BATCH_SIZE) {
            const batch = jioResult.tracks.slice(i, i + BATCH_SIZE);
            const resolved = await Promise.all(
              batch.map((t) => loadJioSaavnAsLavalinkTrack(t, interaction.user, candidateNodes))
            );

            for (const conv of resolved) {
              if (conv) {
                if (!firstTrackStarted && player.node && player.node.id !== conv.node.id && !player.playing) {
                  await player.changeNode(conv.node, false).catch(() => {});
                }
                conv.track.userData = { ...(conv.track.userData || {}), command: "/play" };
                await player.queue.add(conv.track);
                queuedCount++;
                if (!firstTrackStarted && !player.playing && !player.paused) {
                  firstTrackStarted = true;
                  await player.play();
                }
              }
            }
          }

          if (queuedCount > 0) {
            if (!firstTrackStarted && !player.playing && !player.paused) await player.play();
            else await updateActivePlayerMessage(player);

            const source = getSourceInfo("jiosaavn", rawQuery, { command: "/play" });
            const embed = new EmbedBuilder()
              .setColor(source.color)
              .setTitle("🎶 JioSaavn Collection Queued")
              .setDescription(`Added **${queuedCount}** studio tracks from **${jioResult.title}**`)
              .addFields([
                { name: "Collection", value: jioResult.title, inline: true },
                { name: "Tracks Queued", value: `${queuedCount}`, inline: true },
                { name: "Source Fidelity", value: source.badge, inline: true },
              ]);
            if (jioResult.tracks[0]?.artworkUrl) {
              embed.setThumbnail(jioResult.tracks[0].artworkUrl);
            }
            await interaction.editReply({ embeds: [embed] });
            autoDeleteReply(interaction, 12000);
            return;
          }
        }
      }
    }

    // Handle explicit JioSaavn query or URL (e.g. /play jio:Munbe Vaa or saavn:track)
    if (rawQuery.startsWith("jio:") || rawQuery.startsWith("saavn:")) {
      const cleanTerm = rawQuery.replace(/^(jio|saavn):/i, "").trim();
      const jioTrack = await resolveJioSaavnTrack(cleanTerm);
      if (jioTrack) {
        const candidateNodes = [
          ...(player.node?.connected ? [player.node] : []),
          ...Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.connected && n.id !== player.node?.id),
        ];
        const converted = await loadJioSaavnAsLavalinkTrack(jioTrack, interaction.user, candidateNodes);
        if (converted) {
          if (player.node && player.node.id !== converted.node.id && !player.playing) {
            await player.changeNode(converted.node, false).catch(() => {});
          }
          const track = converted.track;
          track.userData = { ...(track.userData || {}), command: "/play" };
          purgeAutoplayTracks(player);
          await player.queue.add(track);
          if (!player.playing && !player.paused) {
            await player.play();
            await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}** [💎 JioSaavn 320 kbps AAC]`);
            autoDeleteReply(interaction, 10000);
          } else {
            await updateActivePlayerMessage(player);
            const source = getSourceInfo(track.info.sourceName, track.info.uri, track.userData);
            const position = player.queue.tracks.length;
            const embed = new EmbedBuilder()
              .setColor(source.color)
              .setTitle("🎶 Added to Queue")
              .setDescription(`**[${track.info.title}](${track.info.uri})**`)
              .addFields([
                { name: "Artist", value: track.info.author || "Unknown Artist", inline: true },
                { name: "Duration", value: formatDuration(track.info.duration || 0), inline: true },
                { name: "Position in Queue", value: `#${position}`, inline: true },
                { name: "Source Fidelity", value: source.badge, inline: true },
              ]);
            if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);
            await interaction.editReply({ embeds: [embed] });
            autoDeleteReply(interaction, 10000);
          }
          return;
        }
      }
    }

    try {
      const { query, isUrl } = await resolveTrackQuery(rawQuery);
      let res = await smartSearch(player, query, isUrl, interaction.user);

      // Fallback for Spotify URL if Lavalink failed to load it directly
      if ((!res || !res.tracks || res.tracks.length === 0 || res.loadType === "empty" || res.loadType === "error") && isUrl && /^https?:\/\/open\.spotify\.com\//i.test(query)) {
        console.log(`[Play Command] Direct Spotify URL failed on Lavalink. Trying oEmbed metadata fallback...`);
        try {
          const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(query)}`;
          const resp = await fetch(oembedUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
          });
          if (resp.ok) {
            const data = (await resp.json()) as { title?: string; author_name?: string };
            if (data.title) {
              const fallbackQuery = `${data.title} ${data.author_name || ""}`.trim();
              console.log(`[Spotify Fallback] Searching "${fallbackQuery}" via smartSearch...`);
              res = await smartSearch(player, fallbackQuery, false, interaction.user);
            }
          }
        } catch (e) {
          console.warn("[Spotify Fallback Error]:", e);
        }
      }

      if (!res || !res.tracks || res.tracks.length === 0 || res.loadType === "empty") {
        await interaction.editReply(`❌ No tracks found for: \`${rawQuery}\``);
        autoDeleteReply(interaction, 10000);
        return;
      }

      if (res.loadType === "error") {
        await interaction.editReply(`⚠️ An error occurred while searching: ${res.exception?.message || "Unknown error"}`);
        autoDeleteReply(interaction, 10000);
        return;
      }

      // Ensure player is operating on best healthy node if current node is degraded or disconnected
      if (!player.node || !player.node.connected || !isNodeHealthy(player.node.id)) {
        const bestNodeId = getBestNode();
        if (bestNodeId && bestNodeId !== player.node?.id) {
          const betterNode = lavalink.nodeManager.nodes.get(bestNodeId);
          if (betterNode?.connected) {
            console.log(`[Play Command] Migrating player from ${player.node?.id || "disconnected"} to healthy "${betterNode.id}"...`);
            await player.changeNode(betterNode, false).catch(() => {});
          }
        }
      }

      // Check if the user explicitly provided a genuine Playlist or Album URL (not an algorithmic mix)
      const isActualPlaylist = isUrl && (
        rawQuery.includes("/playlist") ||
        rawQuery.includes("/album/") ||
        rawQuery.includes("/sets/") ||
        rawQuery.includes("list=PL")
      );

      if (res.loadType === "playlist" && isActualPlaylist) {
        for (const t of res.tracks) {
          t.requester = interaction.user;
          t.userData = { ...(t.userData || {}), command: "/play" };
        }

        // Purge any pre-fetched autoplay tracks so user's playlist takes 100% priority
        purgeAutoplayTracks(player);

        await player.queue.add(res.tracks);
        if (!player.playing && !player.paused) {
          await player.play();
        } else {
          await updateActivePlayerMessage(player);
        }

        const playlistTitle = res.playlist?.name || res.playlist?.title || "Playlist";
        const source = getSourceInfo(res.tracks[0]?.info.sourceName, res.tracks[0]?.info.uri, res.tracks[0]?.userData);
        const embed = new EmbedBuilder()
          .setColor(source.color)
          .setTitle("🎶 Playlist Queued")
          .setDescription(`Added **${res.tracks.length}** tracks from **${playlistTitle}**`)
          .addFields([
            { name: "Total Duration", value: formatDuration(res.playlist?.duration || 0), inline: true },
            { name: "Source Fidelity", value: source.badge, inline: true },
          ]);

        if (res.playlist?.thumbnail) {
          embed.setThumbnail(res.playlist.thumbnail);
        }

        await interaction.editReply({ embeds: [embed] });
        autoDeleteReply(interaction, 12000);
        return;
      }

      // Single track or search result
      const track = res.tracks[0];

      // Check for duplicate in queue or currently playing
      const isAlreadyPlaying = player.queue.current?.info.identifier === track.info.identifier || player.queue.current?.info.uri === track.info.uri;
      const isDuplicateInQueue = player.queue.tracks.some(
        (t) => t.info.identifier === track.info.identifier || t.info.uri === track.info.uri
      );

      track.requester = interaction.user;
      track.userData = { ...(track.userData || {}), command: "/play" };

      // Purge any pre-fetched autoplay tracks so user's track takes 100% priority
      purgeAutoplayTracks(player);

      await player.queue.add(track);

      console.log(`[Play Command] Queued track: "${track.info.title}" (${track.info.uri}) by "${track.info.author}" | Queue size: ${player.queue.tracks.length}`);

      if (!player.playing && !player.paused) {
        await player.play();
        await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}**`);
        autoDeleteReply(interaction, 10000);
      } else {
        await updateActivePlayerMessage(player);
        const source = getSourceInfo(track.info.sourceName, track.info.uri, track.userData);
        const position = player.queue.tracks.length;
        const embed = new EmbedBuilder()
          .setColor(source.color)
          .setTitle("🎶 Added to Queue")
          .setDescription(`**[${track.info.title}](${track.info.uri})**`)
          .addFields([
            { name: "Artist", value: track.info.author || "Unknown Artist", inline: true },
            { name: "Duration", value: formatDuration(track.info.duration || 0), inline: true },
            { name: "Position in Queue", value: `#${position}`, inline: true },
            { name: "Fidelity", value: source.badge, inline: true },
            {
              name: "Up Next",
              value: position === 1
                ? "⏳ Up next! (Plays right after current song. Click ⏭️ on player or use `/skip` to play now)"
                : `⏳ Waiting behind **${position - 1}** track(s). Click ⏭️ on player or use \`/skip\` to play earlier!`,
              inline: false,
            },
          ]);

        if (isAlreadyPlaying) {
          embed.addFields([
            {
              name: "ℹ️ Duplicate Note",
              value: "This song is **currently playing**! It has been added to the queue to play again.",
              inline: false,
            },
          ]);
        } else if (isDuplicateInQueue) {
          embed.addFields([
            {
              name: "ℹ️ Duplicate Note",
              value: "This song is **already in your queue**! It was added again.",
              inline: false,
            },
          ]);
        }

        if (track.info.artworkUrl) {
          embed.setThumbnail(track.info.artworkUrl);
        }

        await interaction.editReply({ embeds: [embed] });
        autoDeleteReply(interaction, 12000);
      }
    } catch (err: any) {
      console.error("[Play Command] Search error:", err);
      await interaction.editReply(`⚠️ Failed to play track: ${err.message || "Unknown error"}`);
      autoDeleteReply(interaction, 10000);
    }
  },
};
