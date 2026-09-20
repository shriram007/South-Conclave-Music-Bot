import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

export const helpCommand = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Display all music commands and high-fidelity streaming features"),

  async execute(interaction: ChatInputCommandInteraction) {
    const botAvatar = interaction.client.user?.displayAvatarURL({ extension: "png", size: 128 });

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setAuthor({
        name: "South Conclave Music Bot",
        ...(botAvatar ? { iconURL: botAvatar } : {}),
      })
      .setTitle("🎧 South Conclave Music Bot — Command Center")
      .setDescription(
        "Studio-grade audio streaming for Discord. Plays songs from **Spotify**, **Apple Music**, **YouTube Music**, **JioSaavn**, and **SoundCloud** using Lavalink audio playback.\n"
      )
      .addFields([
        {
          name: "▶️ Playback Commands",
          value:
            "`/play <query>` — Play any song, album, or playlist (Spotify / Apple Music / YT / JioSaavn)\n" +
            "`/jiosaavn <query>` (or `/jio`) — Stream directly from JioSaavn with the available catalog bitrate\n" +
            "`/pause` — Pause current audio stream\n" +
            "`/resume` — Resume playback\n" +
            "`/skip` — Skip to next song\n" +
            "`/remove <position>` — Remove a specific song from the queue by its number\n" +
            "`/clear` — Clear all upcoming songs from the queue\n" +
            "`/previous` — Replay previous song from history\n" +
            "`/stop` — Clear queue and leave voice channel\n" +
            "`/seek <time>` — Jump to timestamp (e.g. `1:45`)\n" +
            "`/volume <0-100>` — Fine volume adjustment\n" +
            "`/loop <mode>` — Set loop mode (off, track, queue)\n" +
            "`/shuffle` — Randomize queue order\n" +
            "`/autoplay [mode]` — Spotify-style infinite radio when queue ends\n" +
            "`/favorites <play|list|clear>` — Play or manage your saved personal favorites",
        },
        {
          name: "🎛️ Audiophile & Information Commands",
          value:
            "`/filter <preset>` — Studio Hi-Fi EQ, Bass Boost, Treble, 8D, Nightcore, Vaporwave\n" +
            "`/quality` — Check current voice channel bitrate & audio pipeline specs\n" +
            "`/queue [page]` — View upcoming queued songs and total time\n" +
            "`/nowplaying` — Show interactive Spotify-style controller card\n" +
            "`/lyrics [song]` — Look up lyrics for current song or any title\n" +
            "`/help` — Show this guide",
        },
        {
          name: "⚙️ 24/7 Radio Mode",
          value:
            "`/247` — Toggle 24/7 radio mode (bot stays in voice channel permanently)",
        },
        {
          name: "💡 Audiophile Tip for Best Quality",
          value:
            "Ask your server admin to edit your voice channel and drag the **Bitrate slider to the max** (up to 256k or 384k on boosted servers) for the highest available Discord output bitrate!",
        },
      ])
      .setFooter({
        text: "Interactive buttons (Play/Pause, Skip, Loop, Shuffle, EQ) appear under every playing song!",
      });

    return interaction.reply({ embeds: [embed] });
  },
};
