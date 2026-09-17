import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { getOrCreatePlayer, updateActivePlayerMessage } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { clearFavorites, getFavorites } from "../utils/favorites.js";
import { formatDuration } from "../utils/formatters.js";
export const favoritesCommand = {
    data: new SlashCommandBuilder()
        .setName("favorites")
        .setDescription("View or play your personal liked songs (Spotify-style Favorites)")
        .addSubcommand((sub) => sub
        .setName("play")
        .setDescription("Queue and play all your saved favorite tracks"))
        .addSubcommand((sub) => sub
        .setName("list")
        .setDescription("View your list of saved favorite tracks")
        .addIntegerOption((opt) => opt
        .setName("page")
        .setDescription("Page number to view (default: 1)")
        .setMinValue(1)))
        .addSubcommand((sub) => sub
        .setName("clear")
        .setDescription("Clear your saved favorite tracks")),
    async execute(interaction) {
        const subcommand = interaction.options.getSubcommand();
        const userId = interaction.user.id;
        const favorites = getFavorites(userId);
        if (subcommand === "clear") {
            clearFavorites(userId);
            await interaction.reply({
                content: "🗑️ Cleared your personal favorites list.",
            });
            autoDeleteReply(interaction, 8000);
            return;
        }
        if (favorites.length === 0) {
            await interaction.reply({
                content: "❤️ You have no saved favorites yet! Click the **`❤️ Like`** button on any playing song to add it here.",
            });
            autoDeleteReply(interaction, 10000);
            return;
        }
        if (subcommand === "list") {
            const page = interaction.options.getInteger("page") || 1;
            const pageSize = 10;
            const totalPages = Math.ceil(favorites.length / pageSize) || 1;
            const validPage = Math.max(1, Math.min(page, totalPages));
            const startIndex = (validPage - 1) * pageSize;
            const pageTracks = favorites.slice(startIndex, startIndex + pageSize);
            const trackList = pageTracks
                .map((t, idx) => {
                const num = startIndex + idx + 1;
                return `\`${num}.\` **[${t.title}](${t.uri})** — \`${formatDuration(t.duration)}\`\n*by ${t.author}*`;
            })
                .join("\n\n");
            const totalDuration = favorites.reduce((acc, t) => acc + (t.duration || 0), 0);
            const embed = new EmbedBuilder()
                .setColor(0x1db954) // Spotify Green
                .setTitle(`💚 ${interaction.user.username}'s Liked Songs`)
                .setDescription(trackList || "No tracks on this page.")
                .addFields([
                { name: "Total Liked", value: `**${favorites.length}** tracks`, inline: true },
                { name: "Total Duration", value: `**${formatDuration(totalDuration)}**`, inline: true },
            ])
                .setFooter({
                text: `Page ${validPage} of ${totalPages} • Use /favorites play to start your radio!`,
            });
            await interaction.reply({ embeds: [embed] });
            autoDeleteReply(interaction, 30000);
            return;
        }
        if (subcommand === "play") {
            await interaction.deferReply();
            const { player, error } = await getOrCreatePlayer(interaction);
            if (error || !player) {
                await interaction.editReply(error || "❌ Failed to connect to voice channel.");
                return;
            }
            await interaction.editReply(`🔍 Loading **${favorites.length}** of your favorite songs...`);
            let queuedCount = 0;
            for (const fav of favorites) {
                try {
                    const res = await player.search({ query: fav.uri }, interaction.user);
                    if (res?.tracks?.length) {
                        const track = res.tracks[0];
                        track.requester = interaction.user;
                        await player.queue.add(track);
                        queuedCount++;
                    }
                }
                catch { }
            }
            if (queuedCount === 0) {
                await interaction.editReply("❌ Failed to resolve your favorite tracks.");
                autoDeleteReply(interaction, 8000);
                return;
            }
            if (!player.playing && !player.paused) {
                await player.play();
            }
            else {
                await updateActivePlayerMessage(player);
            }
            const embed = new EmbedBuilder()
                .setColor(0x1db954)
                .setTitle("💚 Liked Songs Queued")
                .setDescription(`Loaded and queued **${queuedCount}** tracks from your **Personal Favorites**!`)
                .setFooter({ text: "🎧 South Conclave Spotify-Style Favorites" });
            await interaction.editReply({ content: "", embeds: [embed] });
            autoDeleteReply(interaction, 12000);
        }
    },
};
