import { ActionRowBuilder, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, } from "discord.js";
import { commandMap } from "../commands/index.js";
import { fetchSongLyrics } from "../commands/lyrics.js";
import { clearAllFilters, getBestNode, isNodeHealthy, lavalink, markNodeDegraded, smoothFadePause, smoothFadeResume, updateActivePlayerMessage, validateVoiceGate, } from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";
import { autoDeleteMessage } from "../utils/cleanup.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
import { toggleFavorite } from "../utils/favorites.js";
import { formatDuration } from "../utils/formatters.js";
export async function handleInteraction(interaction) {
    // 1. Handle Slash Commands
    if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
        return;
    }
    // 2. Handle Autocomplete
    if (interaction.isAutocomplete()) {
        const cmd = commandMap.get(interaction.commandName);
        if (cmd && typeof cmd.autocomplete === "function") {
            try {
                await cmd.autocomplete(interaction);
            }
            catch (err) {
                if (err?.code === 10062 || err?.rawError?.code === 10062)
                    return;
                console.error(`[Autocomplete Error] /${interaction.commandName}:`, err);
            }
        }
        return;
    }
    // 3. Handle Button Clicks
    if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
        return;
    }
    // 4. Handle Select Menu (Dropdowns)
    if (interaction.isStringSelectMenu()) {
        await handleSelectMenuInteraction(interaction);
        return;
    }
    // 5. Handle Modal Submissions
    if (interaction.isModalSubmit()) {
        await handleModalSubmitInteraction(interaction);
        return;
    }
}
async function handleSlashCommand(interaction) {
    console.log(`[Interaction] Received /${interaction.commandName} from ${interaction.user.tag} (Channel: ${interaction.channel?.name || interaction.channelId})`);
    const cmd = commandMap.get(interaction.commandName);
    if (!cmd) {
        console.warn(`[Interaction] Command /${interaction.commandName} not found in commandMap`);
        return;
    }
    try {
        await cmd.execute(interaction);
    }
    catch (error) {
        if (error?.code === 10062 || error?.rawError?.code === 10062) {
            console.warn(`[Command Warn] /${interaction.commandName}: Interaction expired before reply (code 10062).`);
            return;
        }
        console.error(`[Command Error] /${interaction.commandName}:`, error);
        const errMessage = "⚠️ An error occurred while executing this command!";
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errMessage, ephemeral: true }).catch(() => { });
        }
        else {
            await interaction.reply({ content: errMessage, ephemeral: true }).catch(() => { });
        }
    }
}
async function handleButtonInteraction(interaction) {
    const player = lavalink.getPlayer(interaction.guildId);
    if (!player) {
        return interaction.reply({
            content: "❌ No active music session found.",
            ephemeral: true,
        });
    }
    // Voice Gate: strictly block anyone who is not in the same voice channel
    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
        return interaction.reply({
            content: gate.error,
            ephemeral: true,
        });
    }
    // Acknowledge Discord immediately to eliminate the 3-second timeout ("didn't respond in time")
    if (interaction.customId === "player_queue" || interaction.customId === "player_lyrics") {
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
    }
    else if (interaction.customId === "player_seek") {
        // showModal requires an un-deferred raw interaction
    }
    else {
        await interaction.deferUpdate().catch(() => { });
    }
    try {
        // Proactive Failover: If the player's node is disconnected or degraded, migrate to best healthy node before sending command
        if (!player.node || !player.node.connected || !isNodeHealthy(player.node.id)) {
            const bestId = getBestNode();
            const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
            if (healthyNode && healthyNode.id !== player.node?.id) {
                console.log(`[Failover] Player's current node (${player.node?.id || "none"}) is disconnected or degraded. Migrating to "${healthyNode.id}"...`);
                await player.changeNode(healthyNode, false).catch(() => { });
            }
        }
        switch (interaction.customId) {
            case "player_pause_resume": {
                console.log(`[Button: Pause/Resume] BEFORE: paused=${player.paused} | Song: "${player.queue.current?.info.title}" | Pos: ${player.position}ms`);
                if (player.paused) {
                    await smoothFadeResume(player);
                }
                else {
                    await smoothFadePause(player);
                }
                console.log(`[Button: Pause/Resume] AFTER: paused=${player.paused} | Song: "${player.queue.current?.info.title}"`);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_seek": {
                if (!player.queue.current) {
                    return interaction.reply({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => { });
                }
                const currentPos = player.position || 0;
                const duration = player.queue.current.info.duration || 0;
                const modal = new ModalBuilder()
                    .setCustomId("modal_player_seek")
                    .setTitle("⏩ Jump to Track Timestamp");
                const input = new TextInputBuilder()
                    .setCustomId("seek_target")
                    .setLabel(`Position (${formatDuration(currentPos)} / ${formatDuration(duration)})`)
                    .setPlaceholder("e.g. 1:30, 90, +30, or -15")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(12);
                const modalRow = new ActionRowBuilder().addComponents(input);
                modal.addComponents(modalRow);
                await interaction.showModal(modal);
                return;
            }
            case "player_rewind_10": {
                if (!player.queue.current) {
                    await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => { });
                    break;
                }
                const currentPos = player.position || 0;
                const newPos = Math.max(0, currentPos - 10000);
                await player.seek(newPos);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_forward_10": {
                if (!player.queue.current) {
                    await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => { });
                    break;
                }
                const currentPos = player.position || 0;
                const maxDuration = player.queue.current.info.duration || Infinity;
                const newPos = Math.min(maxDuration, currentPos + 10000);
                await player.seek(newPos);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_rewind_30": {
                if (!player.queue.current) {
                    await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => { });
                    break;
                }
                const currentPos = player.position || 0;
                const newPos = Math.max(0, currentPos - 30000);
                await player.seek(newPos);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_forward_30": {
                if (!player.queue.current) {
                    await interaction.followUp({ content: "⚠️ No track currently playing.", ephemeral: true }).catch(() => { });
                    break;
                }
                const currentPos = player.position || 0;
                const maxDuration = player.queue.current.info.duration || Infinity;
                const newPos = Math.min(maxDuration, currentPos + 30000);
                await player.seek(newPos);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_skip": {
                try {
                    if (player.queue.tracks.length > 0) {
                        await player.skip();
                    }
                    else {
                        await player.stopPlaying();
                    }
                    if (interaction.channel && "send" in interaction.channel) {
                        const notice = await interaction.channel.send({
                            content: `⏭️ **${interaction.user.username}** skipped the track.`,
                        }).catch(() => null);
                        if (notice)
                            autoDeleteMessage(notice, 5000);
                    }
                }
                catch {
                    await player.stopPlaying().catch(() => { });
                }
                break;
            }
            case "player_prev": {
                if (player.queue.previous.length > 0) {
                    const prev = player.queue.previous[0];
                    await player.queue.add(prev, 0);
                    await player.skip();
                    if (interaction.channel && "send" in interaction.channel) {
                        const notice = await interaction.channel.send({
                            content: `⏮️ **${interaction.user.username}** replayed previous track.`,
                        }).catch(() => null);
                        if (notice)
                            autoDeleteMessage(notice, 5000);
                    }
                }
                else {
                    await interaction.followUp({
                        content: "⚠️ No previous track in history.",
                        ephemeral: true,
                    }).catch(() => { });
                }
                break;
            }
            case "player_stop": {
                await player.filterManager.resetFilters().catch(() => { });
                player.setData("hifi_active", false);
                player.setData("filter_preset_key", "reset");
                player.setData("eq_preset", "Normal (Flat)");
                await player.destroy("Stopped by user via button");
                await interaction.editReply({
                    content: `⏹️ Playback stopped by **${interaction.user.username}**. Equalizer reset to **Normal (Flat)**.`,
                    embeds: [],
                    components: [],
                }).catch(() => { });
                break;
            }
            case "player_loop": {
                const nextMode = player.repeatMode === "off"
                    ? "track"
                    : player.repeatMode === "track"
                        ? "queue"
                        : "off";
                await player.setRepeatMode(nextMode);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                const loopNotice = nextMode === "track"
                    ? "🔂 Looping **current track**."
                    : nextMode === "queue"
                        ? "🔁 Looping **entire queue**."
                        : "➡️ Loop **disabled**.";
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `${loopNotice} (by **${interaction.user.username}**)`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 5000);
                }
                break;
            }
            case "player_shuffle": {
                if (player.queue.tracks.length < 2) {
                    await interaction.followUp({
                        content: "⚠️ Not enough tracks to shuffle.",
                        ephemeral: true,
                    }).catch(() => { });
                    break;
                }
                await player.queue.shuffle();
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `🔀 Queue shuffled by **${interaction.user.username}** (${player.queue.tracks.length} tracks).`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 5000);
                }
                break;
            }
            case "player_voldown": {
                const newVol = Math.max(0, player.volume - 10);
                await player.setVolume(newVol);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_volup": {
                const newVol = Math.min(100, player.volume + 10);
                await player.setVolume(newVol);
                if (newVol === 100) {
                    const activePreset = player.getData("filter_preset_key");
                    if (!activePreset || activePreset === "reset") {
                        await clearAllFilters(player);
                    }
                }
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                break;
            }
            case "player_hifieq": {
                const isCurrentlyActive = Boolean(player.getData("hifi_active"));
                let hifiNoticeText = "";
                if (isCurrentlyActive) {
                    await clearAllFilters(player);
                    await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                    hifiNoticeText = "🔄 Equalizer reset to **Normal (Flat)** (pure lossless audio).";
                }
                else {
                    await clearAllFilters(player);
                    player.setData("hifi_active", true);
                    player.setData("filter_preset_key", "hifi");
                    player.setData("eq_preset", "💎 Hi-Fi Studio");
                    await player.filterManager.setEQ(EQ_PRESETS.hifi);
                    await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                    hifiNoticeText = "💎 **Hi-Fi Studio Preset Activated!** (Audiophile dynamics & crisp highs)";
                }
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `${hifiNoticeText} (by **${interaction.user.username}**)`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 5000);
                }
                break;
            }
            case "player_queue": {
                const current = player.queue.current;
                const upcoming = player.queue.tracks;
                if (!current && upcoming.length === 0) {
                    return interaction.editReply({ content: "⚠️ The queue is currently empty." });
                }
                const embed = new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle("📋 Upcoming Queue")
                    .setDescription(current
                    ? `**Now Playing:**\n🎶 [${current.info.title}](${current.info.uri}) • \`[${formatDuration(current.info.duration || 0)}]\``
                    : "No song currently playing.");
                if (upcoming.length > 0) {
                    const list = upcoming.slice(0, 5).map((t, idx) => {
                        const req = t.requester;
                        const reqTag = req?.username ? ` • @${req.username}` : "";
                        return `**${idx + 1}.** [${t.info.title}](${t.info.uri}) \`[${formatDuration(t.info.duration || 0)}]\`${reqTag}`;
                    }).join("\n\n");
                    const extra = upcoming.length > 5 ? `\n\n*...and ${upcoming.length - 5} more track(s)*` : "";
                    embed.addFields([{ name: "Up Next", value: list + extra }]);
                }
                else {
                    embed.addFields([{ name: "Up Next", value: "No more tracks in queue. Add more with `/play`!" }]);
                }
                return interaction.editReply({ embeds: [embed] });
            }
            case "player_lyrics": {
                const current = player.queue.current;
                if (!current) {
                    return interaction.editReply({ content: "❌ No song is currently playing." });
                }
                const res = await fetchSongLyrics(current.info.title, current.info.author, player, current);
                if (!res.text) {
                    return interaction.editReply({ content: `❌ No lyrics found for **${current.info.title}**.` });
                }
                let lyricsText = res.text;
                if (lyricsText.length > 4000) {
                    lyricsText = lyricsText.substring(0, 3950) + "\n\n*(...lyrics truncated)*";
                }
                const embed = new EmbedBuilder()
                    .setColor(0x5865f2)
                    .setTitle(`📜 Lyrics: ${res.title.substring(0, 100)}`)
                    .setDescription(lyricsText)
                    .setFooter({ text: `Artist: ${res.artist || "Unknown"} | Powered by Studio Lyrics` });
                if (res.artworkUrl)
                    embed.setThumbnail(res.artworkUrl);
                return interaction.editReply({ embeds: [embed] });
            }
            case "player_like": {
                const current = player.queue.current;
                if (!current) {
                    await interaction.followUp({ content: "⚠️ No song is currently playing to like!", ephemeral: true }).catch(() => { });
                    break;
                }
                const res = toggleFavorite(interaction.user.id, {
                    title: current.info.title,
                    uri: current.info.uri || "",
                    author: (current.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim(),
                    duration: current.info.duration || 0,
                    artworkUrl: current.info.artworkUrl || undefined,
                });
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                const noticeContent = res.added
                    ? `❤️ Added **[${current.info.title}](${current.info.uri})** to your favorites! (${res.total} total) • Use \`/favorites play\` anytime.`
                    : `💔 Removed **[${current.info.title}](${current.info.uri})** from your favorites.`;
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `${noticeContent} (by **${interaction.user.username}**)`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 6000);
                }
                break;
            }
            case "player_autoplay": {
                const currentAutoplay = Boolean(player.getData("autoplay") ?? true);
                const newAutoplay = !currentAutoplay;
                player.setData("autoplay", newAutoplay);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                const noticeText = newAutoplay
                    ? "📻 **Smart Autoplay ON:** Infinite Spotify Radio mode will continue when queue ends."
                    : "⏸️ **Smart Autoplay OFF:** Playback will stop when queue ends.";
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `${noticeText} (by **${interaction.user.username}**)`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 6000);
                }
                break;
            }
            default:
                await interaction.followUp({ content: "Unknown button interaction.", ephemeral: true }).catch(() => { });
                break;
        }
    }
    catch (err) {
        if (err?.code === 10062 || err?.rawError?.code === 10062) {
            updateActivePlayerMessage(player, true).catch(() => { });
            return;
        }
        console.error("[Button Interaction Error]:", err?.message || err);
        // If node was reconnecting, timed out, or session dropped, gracefully failover and mark degraded
        if (err.message?.includes("Node Request") ||
            err.message?.includes("not connected") ||
            err.message?.includes("Socket") ||
            err.message?.includes("fetch failed") ||
            err.name === "ConnectTimeoutError" ||
            err.cause?.code === "UND_ERR_CONNECT_TIMEOUT") {
            if (player?.node)
                markNodeDegraded(player.node.id);
            const bestId = getBestNode();
            const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
            if (healthyNode && healthyNode.id !== player.node?.id) {
                console.log(`[Failover] Migrating player after button error from ${player.node?.id || "none"} to "${healthyNode.id}"...`);
                await player.changeNode(healthyNode, false).catch(() => { });
            }
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({
                    content: "🔄 Audio connection refreshed. Please press the button again!",
                    ephemeral: true,
                }).catch(() => { });
            }
            return;
        }
        await interaction.followUp({ content: "⚠️ Action could not be completed. Please try again.", ephemeral: true }).catch(() => { });
    }
}
async function handleSelectMenuInteraction(interaction) {
    const player = lavalink.getPlayer(interaction.guildId);
    if (!player) {
        return interaction.reply({ content: "❌ No active music session found.", ephemeral: true });
    }
    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
        return interaction.reply({ content: gate.error, ephemeral: true });
    }
    // Acknowledge Discord immediately
    await interaction.deferUpdate().catch(() => { });
    try {
        if (!player.node || !player.node.connected || !isNodeHealthy(player.node.id)) {
            const bestId = getBestNode();
            const healthyNode = (bestId ? lavalink.nodeManager.nodes.get(bestId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected && isNodeHealthy(n.id));
            if (healthyNode && healthyNode.id !== player.node?.id) {
                await player.changeNode(healthyNode, false).catch(() => { });
            }
        }
        if (interaction.customId === "player_filter_menu") {
            const preset = interaction.values[0];
            if (preset === "reset") {
                await clearAllFilters(player);
                await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
                if (interaction.channel && "send" in interaction.channel) {
                    const notice = await interaction.channel.send({
                        content: `🔄 Equalizer reset to **Normal (Flat)** (by **${interaction.user.username}**).`,
                    }).catch(() => null);
                    if (notice)
                        autoDeleteMessage(notice, 5000);
                }
                return;
            }
            await clearAllFilters(player);
            player.setData("filter_preset_key", preset);
            let presetLabel = "Normal (Flat)";
            switch (preset) {
                case "hifi":
                    player.setData("hifi_active", true);
                    player.setData("eq_preset", "💎 Hi-Fi Studio");
                    await player.filterManager.setEQ(EQ_PRESETS.hifi);
                    presetLabel = "💎 Hi-Fi Studio";
                    break;
                case "bassboost":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🔊 Bass Boost");
                    await player.filterManager.setEQ(EQ_PRESETS.bassboost);
                    presetLabel = "🔊 Bass Boost";
                    break;
                case "turbo":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🏎️ Turbo Rush");
                    await player.filterManager.setSpeed(1.35);
                    presetLabel = "🏎️ Turbo Rush (1.35x)";
                    break;
                case "treble":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎤 Treble Boost");
                    await player.filterManager.setEQ(EQ_PRESETS.treble);
                    presetLabel = "🎤 Treble Boost";
                    break;
                case "8d":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎧 8D Audio");
                    await player.filterManager.toggleRotation(0.35);
                    presetLabel = "🎧 8D Audio";
                    break;
                case "nightcore":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "⚡ Nightcore");
                    await player.filterManager.toggleNightcore();
                    presetLabel = "⚡ Nightcore";
                    break;
                case "vaporwave":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🌊 Vaporwave");
                    await player.filterManager.toggleVaporwave();
                    presetLabel = "🌊 Vaporwave";
                    break;
                case "karaoke":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎤 Karaoke");
                    await player.filterManager.toggleKaraoke(1, 1, 220, 100);
                    presetLabel = "🎤 Karaoke (Sing-Along)";
                    break;
                case "reset":
                default:
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "Normal (Flat)");
                    presetLabel = "🔄 Normal (Flat Pure Audio)";
                    break;
            }
            await interaction.editReply(buildPlayerMessage(player)).catch(() => updateActivePlayerMessage(player, true));
            if (interaction.channel && "send" in interaction.channel) {
                const notice = await interaction.channel.send({
                    content: `🎛️ **${interaction.user.username}** applied sound filter: **${presetLabel}**`,
                }).catch(() => null);
                if (notice)
                    autoDeleteMessage(notice, 5000);
            }
        }
    }
    catch (err) {
        if (err?.code === 10062 || err?.rawError?.code === 10062) {
            updateActivePlayerMessage(player, true).catch(() => { });
            return;
        }
        console.error("[SelectMenu Interaction Error]:", err);
        await interaction.followUp({ content: "⚠️ Filter could not be applied. Please try again.", ephemeral: true }).catch(() => { });
    }
}
async function handleModalSubmitInteraction(interaction) {
    if (interaction.customId === "modal_player_seek") {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player || !player.queue.current) {
            return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true }).catch(() => { });
        }
        const gate = await validateVoiceGate(interaction, player);
        if (!gate.allowed) {
            return interaction.reply({ content: gate.error, ephemeral: true }).catch(() => { });
        }
        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        const inputRaw = interaction.fields.getTextInputValue("seek_target").trim();
        const duration = player.queue.current.info.duration || 0;
        const currentPos = player.position || 0;
        let targetMs = 0;
        // Relative seek (+30, -15, +1:30)
        if (inputRaw.startsWith("+") || inputRaw.startsWith("-")) {
            const isPositive = inputRaw.startsWith("+");
            const subStr = inputRaw.substring(1).replace(/s$/i, "").trim();
            let deltaMs = 0;
            if (subStr.includes(":")) {
                const parts = subStr.split(":").map(Number);
                if (parts.length === 2)
                    deltaMs = (parts[0] * 60 + parts[1]) * 1000;
                else if (parts.length === 3)
                    deltaMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            }
            else {
                deltaMs = parseFloat(subStr) * 1000;
            }
            if (isNaN(deltaMs)) {
                return interaction.editReply({ content: "❌ Invalid relative seek format! Use e.g. `+30`, `-15`, `+1:30`." });
            }
            targetMs = isPositive ? currentPos + deltaMs : currentPos - deltaMs;
        }
        else {
            // Absolute seek (1:30, 02:45, or 90)
            const cleanStr = inputRaw.replace(/s$/i, "").trim();
            if (cleanStr.includes(":")) {
                const parts = cleanStr.split(":").map(Number);
                if (parts.some(isNaN)) {
                    return interaction.editReply({ content: "❌ Invalid time format! Use `MM:SS` (e.g. `1:30`) or `HH:MM:SS`." });
                }
                if (parts.length === 2)
                    targetMs = (parts[0] * 60 + parts[1]) * 1000;
                else if (parts.length === 3)
                    targetMs = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
            }
            else {
                const sec = parseFloat(cleanStr);
                if (isNaN(sec)) {
                    return interaction.editReply({ content: "❌ Invalid timestamp! Use `MM:SS` (e.g. `1:30`) or seconds (e.g. `90`)." });
                }
                targetMs = sec * 1000;
            }
        }
        targetMs = Math.max(0, Math.min(targetMs, duration));
        await player.seek(targetMs);
        await updateActivePlayerMessage(player, true);
        await interaction.editReply({
            content: `⏩ Jumped to **${formatDuration(targetMs)}** (\`${formatDuration(targetMs)} / ${formatDuration(duration)}\`)`,
        });
        if (interaction.channel && "send" in interaction.channel) {
            const notice = await interaction.channel.send({
                content: `⏩ **${interaction.user.username}** jumped to \`${formatDuration(targetMs)}\``,
            }).catch(() => null);
            if (notice)
                autoDeleteMessage(notice, 5000);
        }
    }
}
