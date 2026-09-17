import { EmbedBuilder, } from "discord.js";
import { commandMap } from "../commands/index.js";
import { fetchSongLyrics } from "../commands/lyrics.js";
import { lavalink, validateVoiceGate } from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
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
    try {
        switch (interaction.customId) {
            case "player_pause_resume": {
                console.log(`[Button: Pause/Resume] BEFORE: paused=${player.paused} | Song: "${player.queue.current?.info.title}" | Pos: ${player.position}ms`);
                if (player.paused) {
                    await player.resume();
                }
                else {
                    await player.pause();
                }
                console.log(`[Button: Pause/Resume] AFTER: paused=${player.paused} | Song: "${player.queue.current?.info.title}"`);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_rewind_10": {
                const currentPos = player.position || 0;
                const newPos = Math.max(0, currentPos - 10000);
                await player.seek(newPos);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_forward_10": {
                const currentPos = player.position || 0;
                const maxDuration = player.queue.current?.info.duration || Infinity;
                const newPos = Math.min(maxDuration, currentPos + 10000);
                await player.seek(newPos);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_rewind_30": {
                const currentPos = player.position || 0;
                const newPos = Math.max(0, currentPos - 30000);
                await player.seek(newPos);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_forward_30": {
                const currentPos = player.position || 0;
                const maxDuration = player.queue.current?.info.duration || Infinity;
                const newPos = Math.min(maxDuration, currentPos + 30000);
                await player.seek(newPos);
                await interaction.update(buildPlayerMessage(player));
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
                    await interaction.reply({
                        content: `⏭️ **${interaction.user.username}** skipped the track.`,
                    }).catch(() => { });
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
                    await interaction.reply({
                        content: `⏮️ **${interaction.user.username}** replayed previous track.`,
                    });
                }
                else {
                    await interaction.reply({
                        content: "⚠️ No previous track in history.",
                        ephemeral: true,
                    });
                }
                break;
            }
            case "player_stop": {
                await player.filterManager.resetFilters().catch(() => { });
                player.setData("hifi_active", false);
                player.setData("eq_preset", "Normal (Flat)");
                await player.destroy("Stopped by user via button");
                await interaction.update({
                    content: `⏹️ Playback stopped by **${interaction.user.username}**. Equalizer reset to **Normal (Flat)**.`,
                    embeds: [],
                    components: [],
                });
                break;
            }
            case "player_loop": {
                const nextMode = player.repeatMode === "off"
                    ? "track"
                    : player.repeatMode === "track"
                        ? "queue"
                        : "off";
                await player.setRepeatMode(nextMode);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_shuffle": {
                if (player.queue.tracks.length < 2) {
                    return interaction.reply({
                        content: "⚠️ Not enough tracks to shuffle.",
                        ephemeral: true,
                    });
                }
                await player.queue.shuffle();
                await interaction.reply({
                    content: `🔀 Queue shuffled by **${interaction.user.username}** (${player.queue.tracks.length} tracks).`,
                });
                break;
            }
            case "player_voldown": {
                const newVol = Math.max(0, player.volume - 10);
                await player.setVolume(newVol);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_volup": {
                const newVol = Math.min(200, player.volume + 10);
                await player.setVolume(newVol);
                await interaction.update(buildPlayerMessage(player));
                break;
            }
            case "player_hifieq": {
                const isCurrentlyActive = Boolean(player.getData("hifi_active"));
                if (isCurrentlyActive) {
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "Normal (Flat)");
                    await player.filterManager.clearEQ();
                    await interaction.update(buildPlayerMessage(player));
                    await interaction.followUp({
                        content: "🔄 Equalizer reset to **Normal (Flat)**.",
                        ephemeral: true,
                    });
                }
                else {
                    player.setData("hifi_active", true);
                    player.setData("eq_preset", "💎 Hi-Fi Studio");
                    await player.filterManager.setEQ(EQ_PRESETS.hifi);
                    await interaction.update(buildPlayerMessage(player));
                    await interaction.followUp({
                        content: "💎 **Hi-Fi Studio Preset Activated!** (Audiophile dynamics & crisp highs)",
                        ephemeral: true,
                    });
                }
                break;
            }
            case "player_queue": {
                const current = player.queue.current;
                const upcoming = player.queue.tracks;
                if (!current && upcoming.length === 0) {
                    return interaction.reply({ content: "⚠️ The queue is currently empty.", ephemeral: true });
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
                return interaction.reply({ embeds: [embed], ephemeral: true });
            }
            case "player_lyrics": {
                const current = player.queue.current;
                if (!current) {
                    return interaction.reply({ content: "❌ No song is currently playing.", ephemeral: true });
                }
                await interaction.deferReply({ ephemeral: true });
                const res = await fetchSongLyrics(current.info.title, current.info.author, player, current);
                if (!res.text) {
                    return interaction.editReply(`❌ No lyrics found for **${current.info.title}**.`);
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
            default:
                await interaction.reply({ content: "Unknown button interaction.", ephemeral: true });
                break;
        }
    }
    catch (err) {
        console.error("[Button Interaction Error]:", err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: `⚠️ Action failed: ${err.message}`, ephemeral: true }).catch(() => { });
        }
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
    if (interaction.customId === "player_filter_menu") {
        const preset = interaction.values[0];
        await player.filterManager.resetFilters();
        await player.filterManager.clearEQ();
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
            case "nuclear":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "💥 Nuclear Bass");
                await player.filterManager.setEQ(EQ_PRESETS.nuclear);
                presetLabel = "💥 Nuclear Bass";
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
            case "chipmunk":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🐿️ Chipmunk");
                await player.filterManager.setSpeed(1.2);
                await player.filterManager.setPitch(1.35);
                presetLabel = "🐿️ Chipmunk Mode";
                break;
            case "robot":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🤖 Robot Synth");
                await player.filterManager.toggleTremolo(14.0, 0.9);
                presetLabel = "🤖 Robot Synth";
                break;
            case "wobbly":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🌀 Drunk / Dizzy");
                await player.filterManager.toggleVibrato(4.0, 0.75);
                presetLabel = "🌀 Drunk / Dizzy";
                break;
            case "karaoke":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🎤 Karaoke");
                await player.filterManager.toggleKaraoke(1, 1, 220, 100);
                presetLabel = "🎤 Karaoke";
                break;
            case "muffled":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🚪 Next Room");
                await player.filterManager.setEQ(EQ_PRESETS.nextdoor);
                await player.filterManager.toggleLowPass(25);
                presetLabel = "🚪 Next Room (Muffled)";
                break;
            case "radio":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "☎️ Vintage Radio");
                await player.filterManager.setEQ(EQ_PRESETS.radio);
                presetLabel = "☎️ 1920s Vintage Radio";
                break;
            case "underwater":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🤿 Underwater");
                await player.filterManager.setEQ(EQ_PRESETS.nextdoor);
                await player.filterManager.toggleTremolo(4.0, 0.6);
                presetLabel = "🤿 Underwater";
                break;
            case "megaphone":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "📢 Megaphone");
                await player.filterManager.setEQ(EQ_PRESETS.megaphone);
                presetLabel = "📢 Megaphone";
                break;
            case "turbo":
                player.setData("hifi_active", false);
                player.setData("eq_preset", "🏎️ Turbo Speed");
                await player.filterManager.setSpeed(1.35);
                presetLabel = "🏎️ Turbo Speed (1.35x)";
                break;
            case "reset":
            default:
                player.setData("hifi_active", false);
                player.setData("eq_preset", "Normal (Flat)");
                presetLabel = "🔄 Normal (Flat Pure Audio)";
                break;
        }
        await interaction.update(buildPlayerMessage(player));
        await interaction.followUp({
            content: `🎛️ Applied sound filter: **${presetLabel}**`,
            ephemeral: true,
        });
    }
}
