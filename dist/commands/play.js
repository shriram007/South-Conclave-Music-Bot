import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { getBestNode, getOrCreatePlayer, isNodeHealthy, lavalink, markNodeDegraded, restrictedTrackIds, updateActivePlayerMessage } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { getFavorites } from "../utils/favorites.js";
import { formatDuration, getSourceInfo, isRelevantTrack } from "../utils/formatters.js";
import { getPlaylist, getUserPlaylists } from "../utils/playlists.js";
import { getMusicSuggestions } from "../utils/suggestions.js";
async function resolveSpotifyTrack(url) {
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
            const data = (await oembedResp.json());
            if (data.title) {
                return `${data.title} ${data.author_name || ""}`.trim();
            }
        }
    }
    catch (e) {
        console.warn("[Spotify Resolver] Error:", e);
    }
    return null;
}
export async function resolveTrackQuery(rawQuery) {
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
        }
        catch (e) {
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
export async function smartSearch(player, query, isUrl, user) {
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
        }
        catch { }
        // Fallback URL search across alternate connected nodes
        const otherNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.id !== player.node.id && n.connected);
        for (const node of otherNodes) {
            try {
                const nodeRes = await node.search({ query }, user);
                if (nodeRes?.tracks?.length && nodeRes.loadType !== "empty" && nodeRes.loadType !== "error") {
                    return nodeRes;
                }
            }
            catch { }
        }
        return null;
    }
    const connectedNodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected && !n.id.includes("Custom"));
    const healthyNodes = connectedNodes.filter((n) => isNodeHealthy(n.id));
    const milloNode = healthyNodes.find((n) => n.id === "Millo-BackupNode");
    const triniumFast = healthyNodes.find((n) => n.id === "Trinium-FastNode");
    const triniumStudio = healthyNodes.find((n) => n.id === "Trinium-Studio");
    const otherHealthy = healthyNodes.filter((n) => n.id !== "Millo-BackupNode" && n.id !== "Trinium-FastNode" && n.id !== "Trinium-Studio");
    const degradedList = connectedNodes.filter((n) => !isNodeHealthy(n.id));
    // Try current player node if healthy, otherwise Millo -> Trinium -> others. Never query degraded nodes unless no healthy nodes exist.
    const playerNodeIfHealthy = (player.node?.connected && isNodeHealthy(player.node.id)) ? [player.node] : [];
    const nodesToTry = healthyNodes.length > 0 ? [
        ...playerNodeIfHealthy,
        ...(milloNode && milloNode.id !== player.node?.id ? [milloNode] : []),
        ...(triniumFast && triniumFast.id !== player.node?.id ? [triniumFast] : []),
        ...(triniumStudio && triniumStudio.id !== player.node?.id ? [triniumStudio] : []),
        ...otherHealthy.filter((n) => n.id !== player.node?.id),
    ] : degradedList;
    // Helper to ensure player is assigned to the healthy resolving node
    const syncPlayerNode = (targetNode) => {
        if (player.node && player.node.id !== targetNode.id && (!player.node.connected || !isNodeHealthy(player.node.id))) {
            console.log(`[SmartSearch] Migrating player from degraded ${player.node.id} to healthy search node ${targetNode.id}...`);
            player.changeNode(targetNode, false).catch(() => { });
        }
    };
    const executeSearchWithTimeout = async (node, searchOpts, timeoutMs = 3500) => {
        const searchPromise = node.search(searchOpts, user);
        const timeoutPromise = new Promise((r) => setTimeout(() => r(null), timeoutMs));
        return Promise.race([searchPromise, timeoutPromise]);
    };
    const handleSearchError = (node, e, label) => {
        const errMsg = e?.message || String(e);
        if (errMsg.includes("Unexpected token '<'") ||
            errMsg.includes("<html>") ||
            errMsg.includes("502") ||
            errMsg.includes("ConnectTimeoutError") ||
            errMsg.includes("fetch failed") ||
            errMsg.includes("timeout")) {
            markNodeDegraded(node.id);
        }
        console.warn(`[SmartSearch] ${label} on "${node.id}" failed:`, errMsg);
    };
    let fallbackCandidate = null;
    // 1. Try YouTube Music (ytmsearch) across connected healthy nodes
    for (const node of nodesToTry) {
        try {
            const res = await executeSearchWithTimeout(node, { query, source: "ytmsearch" });
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                const viable = res.tracks.filter((t) => !restrictedTrackIds.has(t.info.identifier));
                if (viable.length > 0) {
                    if (!fallbackCandidate)
                        fallbackCandidate = { res, node, tracks: viable };
                    const relevant = viable.filter((t) => isRelevantTrack(t.info.title, query) || isRelevantTrack(t.info.author, query));
                    if (relevant.length > 0) {
                        syncPlayerNode(node);
                        console.log(`[SmartSearch] Found "${relevant[0].info.title}" via ytmsearch on node "${node.id}"`);
                        return { ...res, tracks: relevant };
                    }
                }
            }
        }
        catch (e) {
            handleSearchError(node, e, "ytmsearch");
        }
    }
    // 2. Try YouTube search appending "audio" (favors authentic studio tracks over age-gated music videos)
    for (const node of nodesToTry) {
        try {
            const res = await executeSearchWithTimeout(node, { query: `${query} audio`, source: "ytsearch" });
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                const viable = res.tracks.filter((t) => !restrictedTrackIds.has(t.info.identifier));
                if (viable.length > 0) {
                    if (!fallbackCandidate)
                        fallbackCandidate = { res, node, tracks: viable };
                    const relevant = viable.filter((t) => isRelevantTrack(t.info.title, query));
                    if (relevant.length > 0) {
                        syncPlayerNode(node);
                        console.log(`[SmartSearch] Found "${relevant[0].info.title}" via ytsearch (audio) on node "${node.id}"`);
                        return { ...res, tracks: relevant };
                    }
                }
            }
        }
        catch (e) {
            handleSearchError(node, e, "ytsearch (audio)");
        }
    }
    // 3. Try SoundCloud search (scsearch) - ZERO YouTube login walls, fast & unrestricted, verified relevance
    for (const node of nodesToTry) {
        try {
            const res = await executeSearchWithTimeout(node, { query, source: "scsearch" });
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                const viable = res.tracks.filter((t) => !restrictedTrackIds.has(t.info.identifier));
                if (viable.length > 0) {
                    if (!fallbackCandidate)
                        fallbackCandidate = { res, node, tracks: viable };
                    const relevant = viable.filter((t) => isRelevantTrack(t.info.title, query));
                    if (relevant.length > 0) {
                        syncPlayerNode(node);
                        console.log(`[SmartSearch] Found "${relevant[0].info.title}" via scsearch on node "${node.id}"`);
                        return { ...res, tracks: relevant };
                    }
                }
            }
        }
        catch (e) {
            handleSearchError(node, e, "scsearch");
        }
    }
    // 4. Return fallback candidate if no strict relevance match was found across engines
    if (fallbackCandidate) {
        syncPlayerNode(fallbackCandidate.node);
        console.log(`[SmartSearch] Returning best candidate "${fallbackCandidate.tracks[0].info.title}" on node "${fallbackCandidate.node.id}"`);
        return { ...fallbackCandidate.res, tracks: fallbackCandidate.tracks };
    }
    return null;
}
export const playCommand = {
    data: new SlashCommandBuilder()
        .setName("play")
        .setDescription("Play high-quality audio from Spotify, Apple Music, YouTube Music, JioSaavn, or search")
        .addStringOption((option) => option
        .setName("query")
        .setDescription("Song name, artist, or URL (Spotify, Apple Music, YouTube Music, JioSaavn, SoundCloud)")
        .setRequired(true)
        .setAutocomplete(true)),
    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const trimmed = (focusedValue || "").trim();
        const userId = interaction.user.id;
        // Direct URLs don't need autocomplete
        if (/^https?:\/\//i.test(trimmed)) {
            return interaction.respond([]).catch(() => { });
        }
        try {
            const suggestions = await getMusicSuggestions(trimmed, getFavorites(userId), getUserPlaylists(userId), interaction.user.username);
            await interaction.respond(suggestions).catch(() => { });
        }
        catch (e) {
            if (e?.code === 10062 || e?.rawError?.code === 10062)
                return;
            await interaction.respond([]).catch(() => { });
        }
    },
    async execute(interaction) {
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
                let queuedCount = 0;
                let firstTrackStarted = false;
                const BATCH_SIZE = 5;
                for (let i = 0; i < customPlaylist.tracks.length; i += BATCH_SIZE) {
                    const batch = customPlaylist.tracks.slice(i, i + BATCH_SIZE);
                    const resolved = await Promise.all(batch.map(async (t) => {
                        try {
                            let trackRes = await player.search({ query: t.uri }, interaction.user);
                            if (!trackRes?.tracks?.length) {
                                trackRes = await smartSearch(player, `${t.title} ${t.author}`, false, interaction.user);
                            }
                            if (trackRes?.tracks?.length) {
                                const trk = trackRes.tracks[0];
                                trk.requester = interaction.user;
                                return trk;
                            }
                        }
                        catch { }
                        return null;
                    }));
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
                    if (!firstTrackStarted && !player.playing && !player.paused)
                        await player.play();
                    else
                        await updateActivePlayerMessage(player);
                    await interaction.editReply(`🎶 Queued **${queuedCount}** songs from playlist **${customPlaylist.name}**!`);
                    autoDeleteReply(interaction, 10000);
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
                        const data = (await resp.json());
                        if (data.title) {
                            const fallbackQuery = `${data.title} ${data.author_name || ""}`.trim();
                            console.log(`[Spotify Fallback] Searching "${fallbackQuery}" via smartSearch...`);
                            res = await smartSearch(player, fallbackQuery, false, interaction.user);
                        }
                    }
                }
                catch (e) {
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
                        await player.changeNode(betterNode, false).catch(() => { });
                    }
                }
            }
            // Check if the user explicitly provided a genuine Playlist or Album URL (not an algorithmic mix)
            const isActualPlaylist = isUrl && (rawQuery.includes("/playlist") ||
                rawQuery.includes("/album/") ||
                rawQuery.includes("/sets/") ||
                rawQuery.includes("list=PL"));
            if (res.loadType === "playlist" && isActualPlaylist) {
                for (const t of res.tracks) {
                    t.requester = interaction.user;
                }
                // If the only song in queue is an autoplay prefetch, clear it before adding the user's playlist
                if (player.queue.tracks.length === 1 && player.queue.tracks[0].requester?.displayName === "📻 Autoplay Radio") {
                    player.queue.tracks.shift();
                }
                await player.queue.add(res.tracks);
                if (!player.playing && !player.paused) {
                    await player.play();
                }
                else {
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
            const isDuplicateInQueue = player.queue.tracks.some((t) => t.info.identifier === track.info.identifier || t.info.uri === track.info.uri);
            track.requester = interaction.user;
            // If the queue only contains a pre-fetched autoplay track, place user's song ahead of it
            if (player.queue.tracks.length === 1 && player.queue.tracks[0].requester?.displayName === "📻 Autoplay Radio") {
                await player.queue.add(track, 0);
            }
            else {
                await player.queue.add(track);
            }
            console.log(`[Play Command] Queued track: "${track.info.title}" (${track.info.uri}) by "${track.info.author}" | Queue size: ${player.queue.tracks.length}`);
            if (!player.playing && !player.paused) {
                await player.play();
                await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}**`);
                autoDeleteReply(interaction, 10000);
            }
            else {
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
                }
                else if (isDuplicateInQueue) {
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
        }
        catch (err) {
            console.error("[Play Command] Search error:", err);
            await interaction.editReply(`⚠️ Failed to play track: ${err.message || "Unknown error"}`);
            autoDeleteReply(interaction, 10000);
        }
    },
};
