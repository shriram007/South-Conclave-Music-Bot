import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { lavalink, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { formatDuration } from "../utils/formatters.js";
export const moveCommand = {
    data: new SlashCommandBuilder()
        .setName("move")
        .setDescription("Move a track to a different position in the queue")
        .addIntegerOption((opt) => opt
        .setName("track")
        .setDescription("The song you want to move")
        .setRequired(true)
        .setMinValue(1)
        .setAutocomplete(true))
        .addIntegerOption((opt) => opt
        .setName("to")
        .setDescription("The new position number for the song (e.g. 1 to play next)")
        .setRequired(true)
        .setMinValue(1)),
    async autocomplete(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player || player.queue.tracks.length === 0) {
            return interaction.respond([]);
        }
        const focusedValue = interaction.options.getFocused().toLowerCase();
        const tracks = player.queue.tracks;
        const choices = [];
        for (let i = 0; i < tracks.length; i++) {
            if (choices.length >= 25)
                break;
            const t = tracks[i];
            const title = t.info.title.substring(0, 50);
            const author = t.info.author ? ` - ${t.info.author.substring(0, 25)}` : "";
            const dur = t.info.duration ? ` [${formatDuration(t.info.duration)}]` : "";
            const label = `#${i + 1}: ${title}${author}${dur}`.substring(0, 100);
            if (!focusedValue || label.toLowerCase().includes(focusedValue) || `${i + 1}`.startsWith(focusedValue)) {
                choices.push({ name: label, value: i + 1 });
            }
        }
        await interaction.respond(choices);
    },
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player || player.queue.tracks.length === 0) {
            return interaction.reply({
                content: "❌ The queue is empty! There are no upcoming songs to move.",
                ephemeral: true,
            });
        }
        const gate = await validateVoiceGate(interaction, player);
        if (!gate.allowed) {
            return interaction.reply({ content: gate.error, ephemeral: true });
        }
        const fromPos = interaction.options.getInteger("track", true);
        let toPos = interaction.options.getInteger("to", true);
        if (fromPos < 1 || fromPos > player.queue.tracks.length) {
            return interaction.reply({
                content: `❌ Invalid track position to move! Pick a number between **1** and **${player.queue.tracks.length}**.`,
                ephemeral: true,
            });
        }
        // Clamp target position to queue bounds
        toPos = Math.max(1, Math.min(toPos, player.queue.tracks.length));
        if (fromPos === toPos) {
            return interaction.reply({
                content: `ℹ️ Track is already at position **#${fromPos}**.`,
                ephemeral: true,
            });
        }
        const [movedTrack] = player.queue.tracks.splice(fromPos - 1, 1);
        player.queue.tracks.splice(toPos - 1, 0, movedTrack);
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle("🔀 Track Position Updated")
            .setDescription(`Moved **[${movedTrack.info.title}](${movedTrack.info.uri})** from position **#${fromPos}** to **#${toPos}**!` +
            (toPos === 1 ? "\n✨ *This song will play next right after the current track!*" : ""))
            .setFooter({ text: `Requested by ${interaction.user.displayName || interaction.user.username}` })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
        autoDeleteReply(interaction, 10000);
    },
};
