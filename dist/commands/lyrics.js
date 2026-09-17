import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { lavalink } from "../lavalink/client.js";
export const lyricsCommand = {
    data: new SlashCommandBuilder()
        .setName("lyrics")
        .setDescription("Display lyrics for the current song or a searched song")
        .addStringOption((opt) => opt
        .setName("song")
        .setDescription("Song name to search lyrics for (defaults to currently playing song)")
        .setRequired(false)),
    async execute(interaction) {
        await interaction.deferReply();
        const queryOpt = interaction.options.getString("song");
        const player = lavalink.getPlayer(interaction.guildId);
        const current = player?.queue.current;
        let searchTitle = "";
        let searchArtist = "";
        let artworkUrl;
        if (queryOpt) {
            searchTitle = queryOpt.trim();
        }
        else if (current) {
            searchTitle = current.info.title.replace(/\s*\(.*?\)\s*/g, " ").trim();
            searchArtist = current.info.author || "";
            artworkUrl = current.info.artworkUrl;
        }
        else {
            return interaction.editReply("❌ No song is currently playing! Please provide a song name: `/lyrics song: <name>`");
        }
        let lyricsText = null;
        let foundTitle = searchTitle;
        let foundArtist = searchArtist;
        // 1. Attempt native Lavalink lyrics if playing current track
        if (!queryOpt && current) {
            try {
                const lavalinkLyrics = await player.getLyrics(current, false).catch(() => null);
                if (lavalinkLyrics?.text) {
                    lyricsText = lavalinkLyrics.text;
                }
                else if (lavalinkLyrics?.lines && lavalinkLyrics.lines.length > 0) {
                    lyricsText = lavalinkLyrics.lines.map((l) => l.line).join("\n");
                }
            }
            catch { }
        }
        // 2. Fallback to high-coverage LRCLIB Lyrics API
        if (!lyricsText) {
            try {
                const searchQuery = `${searchTitle} ${searchArtist}`.trim();
                const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(searchQuery)}`, { headers: { "User-Agent": "SouthConclaveMusicBot/1.0" }, signal: AbortSignal.timeout(5000) });
                if (res.ok) {
                    const results = (await res.json());
                    if (results && results.length > 0) {
                        const best = results[0];
                        lyricsText = best.plainLyrics || best.syncedLyrics?.replace(/\[.*?\]\s*/g, "") || null;
                        if (best.trackName)
                            foundTitle = best.trackName;
                        if (best.artistName)
                            foundArtist = best.artistName;
                    }
                }
            }
            catch (err) {
                console.warn("[Lyrics] LRCLIB search error:", err);
            }
        }
        if (!lyricsText || lyricsText.trim().length === 0) {
            return interaction.editReply(`❌ No lyrics found for **${searchTitle}**${searchArtist ? ` by ${searchArtist}` : ""}.`);
        }
        // Discord embed description limit is 4096 characters
        if (lyricsText.length > 4000) {
            lyricsText = lyricsText.substring(0, 3950) + "\n\n*(...lyrics truncated)*";
        }
        const embed = new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle(`📜 Lyrics: ${foundTitle.substring(0, 100)}`)
            .setDescription(lyricsText)
            .setFooter({
            text: `Artist: ${foundArtist || "Unknown"} | Powered by Studio Lyrics`,
        });
        if (artworkUrl) {
            embed.setThumbnail(artworkUrl);
        }
        return interaction.editReply({ embeds: [embed] });
    },
};
