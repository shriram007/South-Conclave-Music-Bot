import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getOrCreatePlayer, lavalink, restrictedTrackIds, updateActivePlayerMessage } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { getFavorites } from "../utils/favorites.js";
import { formatDuration, getSourceInfo, isRelevantTrack } from "../utils/formatters.js";

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

async function resolveTrackQuery(rawQuery: string): Promise<{ query: string; isUrl: boolean }> {
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
async function smartSearch(
  player: any,
  query: string,
  isUrl: boolean,
  user: any
) {
  if (isUrl) {
    // Check if the URL was previously marked as restricted / login-required
    for (const id of restrictedTrackIds) {
      if (query.includes(id)) {
        console.warn(`[SmartSearch] Detected previously restricted URL (${id}). Falling back to clean audio search...`);
        return null;
      }
    }

    try {
      const directRes = await player.search({ query }, user);
      if (directRes?.tracks?.length && directRes.loadType !== "empty" && directRes.loadType !== "error") {
        return directRes;
      }
    } catch {}

    // Fallback URL search across alternate connected nodes
    const otherNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n: any) => n.id !== player.node.id && n.connected);
    for (const node of otherNodes) {
      try {
        const nodeRes = await node.search({ query }, user);
        if (nodeRes?.tracks?.length && nodeRes.loadType !== "empty" && nodeRes.loadType !== "error") {
          return nodeRes;
        }
      } catch {}
    }
    return null;
  }

  const serenetia = Array.from(lavalink.nodeManager.nodes.values()).find((n: any) => n.id === "Serenetia-HighSpeed" && n.connected);
  const otherNodes = Array.from(lavalink.nodeManager.nodes.values()).filter(
    (n: any) => n.connected && !n.id.includes("Custom") && n.id !== "Serenetia-HighSpeed"
  );
  const nodesToTry = serenetia
    ? [serenetia, ...otherNodes]
    : (player.node?.connected
      ? [player.node, ...otherNodes.filter((n: any) => n.id !== player.node.id)]
      : otherNodes);

  // 1. Try YouTube Music (ytmsearch) across all connected nodes
  for (const node of nodesToTry) {
    try {
      const res = await node.search({ query, source: "ytmsearch" }, user);
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier));
        if (viable.length > 0) {
          console.log(`[SmartSearch] Found "${viable[0].info.title}" via ytmsearch on node "${node.id}"`);
          return { ...res, tracks: viable };
        }
      }
    } catch (e) {
      console.warn(`[SmartSearch] ytmsearch on "${node.id}" failed:`, (e as any)?.message);
    }
  }

  // 2. Try YouTube search appending "audio" (favors authentic studio tracks over age-gated music videos)
  for (const node of nodesToTry) {
    try {
      const res = await node.search({ query: `${query} audio`, source: "ytsearch" }, user);
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier) && isRelevantTrack(t.info.title, query));
        if (viable.length > 0) {
          console.log(`[SmartSearch] Found "${viable[0].info.title}" via ytsearch (audio) on node "${node.id}"`);
          return { ...res, tracks: viable };
        }
      }
    } catch {}
  }

  // 3. Try SoundCloud search (scsearch) - ZERO YouTube login walls, fast & unrestricted, verified relevance
  for (const node of nodesToTry) {
    try {
      const res = await node.search({ query, source: "scsearch" }, user);
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier) && isRelevantTrack(t.info.title, query));
        if (viable.length > 0) {
          console.log(`[SmartSearch] Found "${viable[0].info.title}" via scsearch on node "${node.id}"`);
          return { ...res, tracks: viable };
        }
      }
    } catch {}
  }

  // 4. Standard ytsearch fallback
  for (const node of nodesToTry) {
    try {
      const res = await node.search({ query, source: "ytsearch" }, user);
      if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
        const viable = res.tracks.filter((t: any) => !restrictedTrackIds.has(t.info.identifier));
        if (viable.length > 0) {
          console.log(`[SmartSearch] Found "${viable[0].info.title}" via ytsearch on node "${node.id}"`);
          return { ...res, tracks: viable };
        }
      }
    } catch {}
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

    // Case 1: Empty or very short input -> Immediately return user favorites + trending tracks
    if (!trimmed || trimmed.length < 1) {
      const choices: { name: string; value: string }[] = [];

      // 1. User's saved favorites first
      const favs = getFavorites(userId).slice(0, 4);
      for (const f of favs) {
        choices.push({
          name: `❤️ Liked: ${f.title.substring(0, 45)} - ${f.author.substring(0, 25)}`.substring(0, 100),
          value: f.uri || f.title,
        });
      }

      // 2. Global trending songs
      const trending = [
        "The Weeknd - Starboy",
        "Lady Gaga, Bruno Mars - Die With A Smile",
        "Billie Eilish - Birds of a Feather",
        "Post Malone, Swae Lee - Sunflower",
        "Ed Sheeran - Shape of You",
        "Coldplay - Viva La Vida",
      ];

      for (const t of trending) {
        if (choices.length >= 10) break;
        choices.push({
          name: `🔥 Trending: ${t}`.substring(0, 100),
          value: t,
        });
      }

      return interaction.respond(choices).catch(() => {});
    }

    // Direct URLs don't need autocomplete
    if (/^https?:\/\//i.test(trimmed)) {
      return interaction.respond([]).catch(() => {});
    }

    try {
      const choices: { name: string; value: string }[] = [];

      // Priority 1: Match against user's saved favorites
      const matchedFavs = getFavorites(userId)
        .filter((f) => f.title.toLowerCase().includes(trimmed.toLowerCase()) || f.author.toLowerCase().includes(trimmed.toLowerCase()))
        .slice(0, 3);

      for (const f of matchedFavs) {
        choices.push({
          name: `❤️ ${f.title.substring(0, 45)} - ${f.author.substring(0, 25)} [Liked]`.substring(0, 100),
          value: f.uri || f.title,
        });
      }

      // Priority 2: Ultra-low latency YouTube Suggest API (~40ms response)
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1200);
        const resp = await fetch(
          `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        );
        clearTimeout(timeoutId);

        if (resp.ok) {
          const data = (await resp.json()) as [string, string[]];
          if (Array.isArray(data[1])) {
            for (const item of data[1]) {
              if (choices.length >= 8) break;
              if (!choices.some((c) => c.value.toLowerCase() === item.toLowerCase())) {
                choices.push({
                  name: `🎵 ${item}`.substring(0, 100),
                  value: item,
                });
              }
            }
          }
        }
      } catch {}

      // Priority 3: Fast Lavalink node track lookup (bounded to strict 700ms race)
      if (choices.length < 8) {
        try {
          const serenetia = lavalink.nodeManager.nodes.get("Serenetia-HighSpeed");
          const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
          const nodeToUse = serenetia?.connected ? serenetia : connectedNodes[0];

          if (nodeToUse) {
            const searchPromise = nodeToUse.search({ query: trimmed, source: "ytmsearch" }, interaction.user);
            const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 700));
            const res: any = await Promise.race([searchPromise, timeoutPromise]);

            if (res?.tracks?.length) {
              for (const t of res.tracks.slice(0, 4)) {
                if (choices.length >= 10) break;
                const title = t.info.title.substring(0, 45);
                const author = t.info.author ? ` - ${t.info.author.substring(0, 25)}` : "";
                const duration = t.info.duration ? ` [${formatDuration(t.info.duration)}]` : "";
                const label = `🎶 ${title}${author}${duration}`.substring(0, 100);
                const val = t.info.uri || t.info.title;

                if (!choices.some((c) => c.value === val)) {
                  choices.push({ name: label, value: val });
                }
              }
            }
          }
        } catch {}
      }

      await interaction.respond(choices.slice(0, 10));
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

      // Ensure player is operating on proxy nodes (with active YouTube proxies) instead of blocked nodes
      if (player.node?.id === "Trinium-FastNode" || player.node?.id === "Jirayu-AuxNode") {
        const serenetia = lavalink.nodeManager.nodes.get("Serenetia-HighSpeed");
        const millo = lavalink.nodeManager.nodes.get("Millo-BackupNode");
        const betterNode = serenetia?.connected ? serenetia : (millo?.connected ? millo : null);
        if (betterNode && betterNode.id !== player.node.id) {
          console.log(`[Play Command] Migrating player from ${player.node.id} to ${betterNode.id}...`);
          await player.changeNode(betterNode, false).catch(() => {});
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
        }
        await player.queue.add(res.tracks);
        if (!player.playing && !player.paused) {
          await player.play();
        } else {
          await updateActivePlayerMessage(player);
        }

        const playlistTitle = res.playlist?.name || res.playlist?.title || "Playlist";
        const source = getSourceInfo(res.tracks[0]?.info.sourceName);
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
      await player.queue.add(track);

      console.log(`[Play Command] Queued track: "${track.info.title}" (${track.info.uri}) by "${track.info.author}" | Queue size: ${player.queue.tracks.length}`);

      if (!player.playing && !player.paused) {
        await player.play();
        await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}**`);
        autoDeleteReply(interaction, 10000);
      } else {
        await updateActivePlayerMessage(player);
        const source = getSourceInfo(track.info.sourceName);
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
