import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink } from "../lavalink/client.js";

export async function fetchSongLyrics(
  title: string,
  artist?: string,
  player?: any,
  currentTrack?: any
): Promise<{
  title: string;
  artist: string;
  text: string | null;
  artworkUrl?: string | null;
}> {
  let lyricsText: string | null = null;
  let foundTitle = title;
  let foundArtist = artist || "";
  const artworkUrl = currentTrack?.info?.artworkUrl;

  // 1. Native Lavalink lyrics
  if (player && currentTrack) {
    try {
      const lavalinkLyrics = await player.getLyrics(currentTrack, false).catch(() => null);
      if (lavalinkLyrics?.text) {
        lyricsText = lavalinkLyrics.text;
      } else if (lavalinkLyrics?.lines && lavalinkLyrics.lines.length > 0) {
        lyricsText = lavalinkLyrics.lines.map((l: any) => l.line).join("\n");
      }
    } catch {}
  }

  // 2. LRCLIB fallback
  if (!lyricsText) {
    try {
      const searchQuery = `${title} ${artist || ""}`.trim();
      const res = await fetch(
        `https://lrclib.net/api/search?q=${encodeURIComponent(searchQuery)}`,
        { headers: { "User-Agent": "SouthConclaveMusicBot/1.0" }, signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const results = (await res.json()) as any[];
        if (results && results.length > 0) {
          const best = results[0];
          lyricsText = best.plainLyrics || best.syncedLyrics?.replace(/\[.*?\]\s*/g, "") || null;
          if (best.trackName) foundTitle = best.trackName;
          if (best.artistName) foundArtist = best.artistName;
        }
      }
    } catch (err) {
      console.warn("[Lyrics] LRCLIB search error:", err);
    }
  }

  return { title: foundTitle, artist: foundArtist, text: lyricsText, artworkUrl };
}

export const lyricsCommand = {
  data: new SlashCommandBuilder()
    .setName("lyrics")
    .setDescription("Display lyrics for the current song or a searched song")
    .addStringOption((opt) =>
      opt
        .setName("song")
        .setDescription("Song name to search lyrics for (defaults to currently playing song)")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply();

    const queryOpt = interaction.options.getString("song");
    const player = lavalink.getPlayer(interaction.guildId!);
    const current = player?.queue.current;

    let searchTitle = "";
    let searchArtist = "";

    if (queryOpt) {
      searchTitle = queryOpt.trim();
    } else if (current) {
      searchTitle = current.info.title.replace(/\s*\(.*?\)\s*/g, " ").trim();
      searchArtist = current.info.author || "";
    } else {
      return interaction.editReply(
        "❌ No song is currently playing! Please provide a song name: `/lyrics song: <name>`"
      );
    }

    const res = await fetchSongLyrics(searchTitle, searchArtist, player, current);
    let lyricsText = res.text;

    if (!lyricsText || lyricsText.trim().length === 0) {
      return interaction.editReply(
        `❌ No lyrics found for **${searchTitle}**${searchArtist ? ` by ${searchArtist}` : ""}.`
      );
    }

    if (lyricsText.length > 4000) {
      lyricsText = lyricsText.substring(0, 3950) + "\n\n*(...lyrics truncated)*";
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📜 Lyrics: ${res.title.substring(0, 100)}`)
      .setDescription(lyricsText)
      .setFooter({
        text: `Artist: ${res.artist || "Unknown"} | Powered by Studio Lyrics`,
      });

    if (res.artworkUrl) {
      embed.setThumbnail(res.artworkUrl);
    }

    return interaction.editReply({ embeds: [embed] });
  },
};
