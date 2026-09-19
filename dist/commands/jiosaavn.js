import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { getOrCreatePlayer, lavalink, purgeAutoplayTracks, updateActivePlayerMessage, } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { formatDuration, getSourceInfo } from "../utils/formatters.js";
import { isJioSaavnUrl, loadJioSaavnAsLavalinkTrack, resolveJioSaavnTrack, resolveJioSaavnUrl, searchJioSaavn, } from "../services/jiosaavn.js";
async function executeJioSaavn(interaction) {
    await interaction.deferReply();
    const { player, error } = await getOrCreatePlayer(interaction);
    if (error || !player) {
        await interaction.editReply(error || "❌ Failed to connect to voice channel.");
        return;
    }
    const rawQuery = interaction.options.getString("query", true).trim();
    console.log(`[JioSaavn Command] User: "${interaction.user.tag}" (${interaction.user.id}) in "${interaction.guild?.name}" | Query: "${rawQuery}"`);
    const candidateNodes = [
        ...(player.node?.connected ? [player.node] : []),
        ...Array.from(lavalink.nodeManager.nodes.values()).filter((n) => n.connected && n.id !== player.node?.id),
    ];
    // 1. Direct JioSaavn URL (Song, Album, or Playlist)
    if (isJioSaavnUrl(rawQuery)) {
        const jioResult = await resolveJioSaavnUrl(rawQuery);
        if (jioResult) {
            if (jioResult.type === "track") {
                const converted = await loadJioSaavnAsLavalinkTrack(jioResult.track, interaction.user, candidateNodes);
                if (converted) {
                    if (player.node && player.node.id !== converted.node.id && !player.playing) {
                        await player.changeNode(converted.node, false).catch(() => { });
                    }
                    const track = converted.track;
                    purgeAutoplayTracks(player);
                    await player.queue.add(track);
                    if (!player.playing && !player.paused) {
                        await player.play();
                        await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}** [💎 JioSaavn 320 kbps AAC]`);
                        autoDeleteReply(interaction, 10000);
                    }
                    else {
                        await updateActivePlayerMessage(player);
                        const source = getSourceInfo(track.info.sourceName, track.info.uri);
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
                        if (track.info.artworkUrl)
                            embed.setThumbnail(track.info.artworkUrl);
                        await interaction.editReply({ embeds: [embed] });
                        autoDeleteReply(interaction, 10000);
                    }
                    return;
                }
            }
            else if (jioResult.type === "playlist") {
                purgeAutoplayTracks(player);
                let queuedCount = 0;
                let firstTrackStarted = false;
                const BATCH_SIZE = 5;
                for (let i = 0; i < jioResult.tracks.length; i += BATCH_SIZE) {
                    const batch = jioResult.tracks.slice(i, i + BATCH_SIZE);
                    const resolved = await Promise.all(batch.map((t) => loadJioSaavnAsLavalinkTrack(t, interaction.user, candidateNodes)));
                    for (const conv of resolved) {
                        if (conv) {
                            if (!firstTrackStarted && player.node && player.node.id !== conv.node.id && !player.playing) {
                                await player.changeNode(conv.node, false).catch(() => { });
                            }
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
                    if (!firstTrackStarted && !player.playing && !player.paused)
                        await player.play();
                    else
                        await updateActivePlayerMessage(player);
                    const source = getSourceInfo("jiosaavn", rawQuery);
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
    // 2. Direct Text Search on JioSaavn Catalog
    let jioTrack = await resolveJioSaavnTrack(rawQuery);
    if (!jioTrack) {
        const searchResults = await searchJioSaavn(rawQuery, 3);
        if (searchResults.length > 0) {
            jioTrack = searchResults[0];
        }
    }
    if (jioTrack) {
        const converted = await loadJioSaavnAsLavalinkTrack(jioTrack, interaction.user, candidateNodes);
        if (converted) {
            if (player.node && player.node.id !== converted.node.id && !player.playing) {
                await player.changeNode(converted.node, false).catch(() => { });
            }
            const track = converted.track;
            purgeAutoplayTracks(player);
            await player.queue.add(track);
            if (!player.playing && !player.paused) {
                await player.play();
                await interaction.editReply(`▶️ Playing **[${track.info.title}](${track.info.uri})** by **${track.info.author}** [💎 JioSaavn 320 kbps AAC]`);
                autoDeleteReply(interaction, 10000);
            }
            else {
                await updateActivePlayerMessage(player);
                const source = getSourceInfo(track.info.sourceName, track.info.uri);
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
                if (track.info.artworkUrl)
                    embed.setThumbnail(track.info.artworkUrl);
                await interaction.editReply({ embeds: [embed] });
                autoDeleteReply(interaction, 10000);
            }
            return;
        }
    }
    await interaction.editReply(`❌ No studio tracks found on JioSaavn for: \`${rawQuery}\`\n💡 Try checking spelling, selecting from the autocomplete list, or using \`/play\` for universal search.`);
    autoDeleteReply(interaction, 10000);
}
async function autocompleteJioSaavn(interaction) {
    const focusedValue = interaction.options.getFocused();
    const trimmed = (focusedValue || "").trim();
    if (!trimmed || trimmed.length < 2 || /^https?:\/\//i.test(trimmed)) {
        return interaction.respond([]).catch(() => { });
    }
    try {
        const results = await searchJioSaavn(trimmed, 10);
        const choices = results.map((t) => {
            const titlePart = t.title;
            const artistPart = t.artist ? ` - ${t.artist}` : "";
            const albumPart = t.album ? ` (${t.album})` : "";
            const name = `${titlePart}${artistPart}${albumPart}`.slice(0, 100);
            return {
                name,
                value: t.uri || `${t.title} ${t.artist}`,
            };
        });
        await interaction.respond(choices).catch(() => { });
    }
    catch {
        await interaction.respond([]).catch(() => { });
    }
}
export const jiosaavnCommand = {
    data: new SlashCommandBuilder()
        .setName("jiosaavn")
        .setDescription("Play songs directly from JioSaavn in pristine 320 kbps Studio Master quality")
        .addStringOption((option) => option
        .setName("query")
        .setDescription("Song name, artist, or JioSaavn URL (album, song, playlist)")
        .setRequired(true)
        .setAutocomplete(true)),
    autocomplete: autocompleteJioSaavn,
    execute: executeJioSaavn,
};
export const jioCommand = {
    data: new SlashCommandBuilder()
        .setName("jio")
        .setDescription("Play songs directly from JioSaavn in pristine 320 kbps Studio Master quality (shortcut)")
        .addStringOption((option) => option
        .setName("query")
        .setDescription("Song name, artist, or JioSaavn URL (album, song, playlist)")
        .setRequired(true)
        .setAutocomplete(true)),
    autocomplete: autocompleteJioSaavn,
    execute: executeJioSaavn,
};
