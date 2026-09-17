import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { getOrCreatePlayer, lavalink, updateActivePlayerMessage } from "../lavalink/client.js";
import { formatDuration, getSourceInfo } from "../utils/formatters.js";
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
async function resolveTrackQuery(rawQuery) {
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
async function smartSearch(player, query, isUrl, user) {
    if (isUrl) {
        try {
            const direct = await player.search({ query }, user);
            if (direct?.tracks?.length && direct.loadType !== "empty" && direct.loadType !== "error") {
                return direct;
            }
        }
        catch { }
        for (const node of lavalink.nodeManager.nodes.values()) {
            if (node.connected && node.id !== player.node.id) {
                try {
                    const nodeRes = await node.search({ query }, user);
                    if (nodeRes?.tracks?.length && nodeRes.loadType !== "empty" && nodeRes.loadType !== "error") {
                        return nodeRes;
                    }
                }
                catch { }
            }
        }
        return null;
    }
    const nodesToTry = [
        player.node,
        ...Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.id !== player.node.id && n.connected),
    ];
    // 1. Try YouTube Music (ytmsearch) across all connected nodes
    for (const node of nodesToTry) {
        try {
            const res = await node.search({ query, source: "ytmsearch" }, user);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                console.log(`[SmartSearch] Found "${res.tracks[0].info.title}" via ytmsearch on node "${node.id}"`);
                return res;
            }
        }
        catch (e) {
            console.warn(`[SmartSearch] ytmsearch on "${node.id}" failed:`, e?.message);
        }
    }
    // 2. Try SoundCloud search (scsearch)
    for (const node of nodesToTry) {
        try {
            const res = await node.search({ query, source: "scsearch" }, user);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                console.log(`[SmartSearch] Found "${res.tracks[0].info.title}" via scsearch on node "${node.id}"`);
                return res;
            }
        }
        catch { }
    }
    // 3. Try YouTube search appending "audio" (favors clean audio streams over age-gated music videos)
    for (const node of nodesToTry) {
        try {
            const res = await node.search({ query: `${query} audio`, source: "ytsearch" }, user);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                console.log(`[SmartSearch] Found "${res.tracks[0].info.title}" via ytsearch (audio) on node "${node.id}"`);
                return res;
            }
        }
        catch { }
    }
    // 4. Standard ytsearch
    for (const node of nodesToTry) {
        try {
            const res = await node.search({ query, source: "ytsearch" }, user);
            if (res?.tracks?.length && res.loadType !== "empty" && res.loadType !== "error") {
                console.log(`[SmartSearch] Found "${res.tracks[0].info.title}" via ytsearch on node "${node.id}"`);
                return res;
            }
        }
        catch { }
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
        if (!focusedValue || focusedValue.trim().length < 2) {
            return interaction.respond([]);
        }
        const trimmed = focusedValue.trim();
        if (/^https?:\/\//i.test(trimmed)) {
            return interaction.respond([]);
        }
        try {
            const nodes = Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected);
            if (nodes.length === 0)
                return interaction.respond([]);
            let res = null;
            for (const node of nodes) {
                try {
                    res = await node.search({ query: trimmed, source: "ytmsearch" }, interaction.user);
                    if (res?.tracks?.length)
                        break;
                }
                catch { }
            }
            if (!res?.tracks?.length) {
                for (const node of nodes) {
                    try {
                        res = await node.search({ query: trimmed, source: "ytsearch" }, interaction.user);
                        if (res?.tracks?.length)
                            break;
                    }
                    catch { }
                }
            }
            if (!res || !res.tracks || res.tracks.length === 0) {
                return interaction.respond([]);
            }
            const tracks = res.tracks.slice(0, 8);
            const choices = tracks.map((t) => {
                const title = t.info.title.substring(0, 50);
                const author = t.info.author ? ` - ${t.info.author.substring(0, 25)}` : "";
                const duration = t.info.duration ? ` [${formatDuration(t.info.duration)}]` : "";
                const label = `${title}${author}${duration}`.substring(0, 100);
                return {
                    name: label,
                    value: t.info.uri || t.info.title,
                };
            });
            await interaction.respond(choices);
        }
        catch (e) {
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
                return;
            }
            if (res.loadType === "error") {
                await interaction.editReply(`⚠️ An error occurred while searching: ${res.exception?.message || "Unknown error"}`);
                return;
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
                return;
            }
            // Single track or search result
            const track = res.tracks[0];
            // Check for duplicate in queue or currently playing
            const isAlreadyPlaying = player.queue.current?.info.identifier === track.info.identifier || player.queue.current?.info.uri === track.info.uri;
            const isDuplicateInQueue = player.queue.tracks.some((t) => t.info.identifier === track.info.identifier || t.info.uri === track.info.uri);
            track.requester = interaction.user;
            await player.queue.add(track);
            console.log(`[Play Command] Queued track: "${track.info.title}" (${track.info.uri}) by "${track.info.author}" | Queue size: ${player.queue.tracks.length}`);
            if (!player.playing && !player.paused) {
                await player.play();
                await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}**`);
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
            }
        }
        catch (err) {
            console.error("[Play Command] Search error:", err);
            await interaction.editReply(`⚠️ Failed to play track: ${err.message || "Unknown error"}`);
        }
    },
};
