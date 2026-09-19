import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getOrCreatePlayer, lavalink, purgeAutoplayTracks, updateActivePlayerMessage } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { formatDuration } from "../utils/formatters.js";
import {
  addQueueToPlaylist,
  addSongToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getUserPlaylists,
  PlaylistTrack,
} from "../utils/playlists.js";
import { resolveTrackQuery, smartSearch } from "./play.js";

export const playlistCommand = {
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Create, manage, and play your custom playlists and Liked Songs")
    .addSubcommand((sub) =>
      sub
        .setName("play")
        .setDescription("Queue and play an entire playlist")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Name of the playlist to play")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("View all your playlists and song counts")
    )
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("Inspect songs inside a specific playlist")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Playlist name to view")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("page")
            .setDescription("Page number (default: 1)")
            .setMinValue(1)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Create a new empty custom playlist")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Name for your new playlist")
            .setRequired(true)
            .setMaxLength(50)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-song")
        .setDescription("Add a song to a playlist")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Playlist to add song to")
            .setRequired(true)
            .setAutocomplete(true)
        )
        .addStringOption((opt) =>
          opt
            .setName("song")
            .setDescription("Song name, YouTube URL, or Spotify link")
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("add-queue")
        .setDescription("Save all currently playing & queued tracks into a playlist")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Playlist name to save tracks to")
            .setRequired(true)
            .setAutocomplete(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("delete")
        .setDescription("Delete a custom playlist")
        .addStringOption((opt) =>
          opt
            .setName("playlist")
            .setDescription("Playlist to delete")
            .setRequired(true)
            .setAutocomplete(true)
        )
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const focusedValue = (interaction.options.getFocused() || "").toLowerCase();
    const playlists = getUserPlaylists(interaction.user.id);
    const choices = playlists.map((p) => ({
      name: `${p.name} (${p.tracks.length} tracks)`,
      value: p.name,
    }));
    const filtered = choices
      .filter((c) => c.name.toLowerCase().includes(focusedValue) || c.value.toLowerCase().includes(focusedValue))
      .slice(0, 25);
    await interaction.respond(filtered).catch(() => {});
  },

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;

    // 1. /playlist list
    if (subcommand === "list") {
      const playlists = getUserPlaylists(userId);
      if (playlists.length === 0) {
        return interaction.reply({
          content:
            "📂 You don't have any playlists yet!\n• Use `/playlist create <name>` to start a custom playlist.\n• Or click the **`❤️ Like`** button on any playing song to automatically create your **Liked Songs** playlist!",
          ephemeral: true,
        });
      }

      const totalTracks = playlists.reduce((acc, p) => acc + p.tracks.length, 0);
      const desc = playlists
        .map((p, idx) => {
          const totalMs = p.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);
          return `**${idx + 1}. ${p.name}**\n↳ 🎵 **${p.tracks.length}** songs • \`${formatDuration(totalMs)}\``;
        })
        .join("\n\n");

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🎶 ${interaction.user.username}'s Playlists`)
        .setDescription(desc)
        .setFooter({ text: `Total Playlists: ${playlists.length} • Total Songs: ${totalTracks} • Play with /playlist play <name>` });

      return interaction.reply({ embeds: [embed] });
    }

    // 2. /playlist create <name>
    if (subcommand === "create") {
      const name = interaction.options.getString("name", true).trim();
      const res = createPlaylist(userId, name);
      if (!res.success) {
        return interaction.reply({ content: res.error || "❌ Failed to create playlist.", ephemeral: true });
      }

      return interaction.reply({
        content: `🎉 Created new playlist: **${res.playlist!.name}**!\n• Add songs with \`/playlist add-song playlist:${res.playlist!.name} song:<song>\`\n• Or save your current queue with \`/playlist add-queue playlist:${res.playlist!.name}\``,
      });
    }

    // 3. /playlist view <name>
    if (subcommand === "view") {
      const name = interaction.options.getString("name", true).trim();
      const playlist = getPlaylist(userId, name);
      if (!playlist) {
        return interaction.reply({ content: `❌ Playlist **${name}** not found.`, ephemeral: true });
      }

      if (playlist.tracks.length === 0) {
        return interaction.reply({
          content: `📂 Playlist **${playlist.name}** is currently empty. Add songs using \`/playlist add-song\`!`,
          ephemeral: true,
        });
      }

      const page = interaction.options.getInteger("page") || 1;
      const pageSize = 10;
      const totalPages = Math.max(1, Math.ceil(playlist.tracks.length / pageSize));
      const safePage = Math.max(1, Math.min(page, totalPages));
      const startIdx = (safePage - 1) * pageSize;
      const pageTracks = playlist.tracks.slice(startIdx, startIdx + pageSize);

      const trackList = pageTracks
        .map((t, idx) => {
          const num = startIdx + idx + 1;
          const dur = formatDuration(t.duration || 0);
          return `\`${num}.\` **[${t.title}](${t.uri})** — \`${dur}\`\n*by ${t.author}*`;
        })
        .join("\n\n");

      const totalMs = playlist.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`📂 Playlist: ${playlist.name}`)
        .setDescription(trackList)
        .addFields([
          { name: "Total Songs", value: `**${playlist.tracks.length}**`, inline: true },
          { name: "Total Duration", value: `**${formatDuration(totalMs)}**`, inline: true },
        ])
        .setFooter({ text: `Page ${safePage} of ${totalPages} • Use /playlist play name:${playlist.name} to stream` });

      return interaction.reply({ embeds: [embed] });
    }

    // 4. /playlist delete <playlist>
    if (subcommand === "delete") {
      const name = interaction.options.getString("playlist", true).trim();
      if (name.toLowerCase().includes("liked songs") || name.toLowerCase().includes("favorites")) {
        return interaction.reply({
          content: "❌ You cannot delete the automatic 'Liked Songs' playlist. Use `/favorites clear` to clear liked songs.",
          ephemeral: true,
        });
      }

      const res = deletePlaylist(userId, name);
      if (!res.success) {
        return interaction.reply({ content: res.error || "❌ Failed to delete playlist.", ephemeral: true });
      }

      return interaction.reply({ content: `🗑️ Deleted custom playlist: **${name}**.` });
    }

    // 5. /playlist add-song <playlist> <song>
    if (subcommand === "add-song") {
      const playlistName = interaction.options.getString("playlist", true).trim();
      const songQuery = interaction.options.getString("song", true).trim();

      const existingPlaylist = getPlaylist(userId, playlistName);
      if (!existingPlaylist) {
        return interaction.reply({
          content: `❌ Playlist **${playlistName}** does not exist. Create it first using \`/playlist create name:${playlistName}\`!`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      // Resolve query using player or best node
      let player = lavalink.getPlayer(interaction.guildId!);
      const { query, isUrl } = await resolveTrackQuery(songQuery);

      let searchRes: any = null;
      if (player) {
        searchRes = await smartSearch(player, query, isUrl, interaction.user);
      } else {
        const defaultNode = lavalink.nodeManager.nodes.values().next().value;
        const dummyPlayer = {
          node: defaultNode,
          search: (opts: any, user: any) => defaultNode ? defaultNode.search(opts, user) : Promise.resolve(null),
        };
        searchRes = await smartSearch(dummyPlayer, query, isUrl, interaction.user);
      }

      if (!searchRes?.tracks?.length) {
        await interaction.editReply(`❌ No audio tracks found for \`${songQuery}\`.`);
        autoDeleteReply(interaction, 8000);
        return;
      }

      const track = searchRes.tracks[0];
      const newTrack: PlaylistTrack = {
        title: track.info.title,
        uri: track.info.uri || "",
        author: (track.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim(),
        duration: track.info.duration || 0,
        artworkUrl: track.info.artworkUrl || undefined,
        addedAt: Date.now(),
      };

      const addRes = addSongToPlaylist(userId, playlistName, newTrack);
      if (!addRes.success) {
        await interaction.editReply(addRes.error || "❌ Failed to add song to playlist.");
        autoDeleteReply(interaction, 8000);
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("🎵 Song Added to Playlist")
        .setDescription(`Added **[${newTrack.title}](${newTrack.uri})** to **${playlistName}**!`)
        .setFooter({ text: `Total songs in ${playlistName}: ${addRes.totalTracks}` });

      if (newTrack.artworkUrl) embed.setThumbnail(newTrack.artworkUrl);

      await interaction.editReply({ embeds: [embed] });
      autoDeleteReply(interaction, 10000);
      return;
    }

    // 6. /playlist add-queue <playlist>
    if (subcommand === "add-queue") {
      const playlistName = interaction.options.getString("playlist", true).trim();
      const player = lavalink.getPlayer(interaction.guildId!);
      if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
        return interaction.reply({
          content: "❌ No songs are currently playing or in the queue to save!",
          ephemeral: true,
        });
      }

      const tracksToSave: PlaylistTrack[] = [];
      if (player.queue.current) {
        tracksToSave.push({
          title: player.queue.current.info.title,
          uri: player.queue.current.info.uri || "",
          author: (player.queue.current.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim(),
          duration: player.queue.current.info.duration || 0,
          artworkUrl: player.queue.current.info.artworkUrl || undefined,
          addedAt: Date.now(),
        });
      }

      for (const t of player.queue.tracks) {
        tracksToSave.push({
          title: t.info.title,
          uri: t.info.uri || "",
          author: (t.info.author || "Unknown Artist").replace(/- Topic/gi, "").trim(),
          duration: t.info.duration || 0,
          artworkUrl: t.info.artworkUrl || undefined,
          addedAt: Date.now(),
        });
      }

      const res = addQueueToPlaylist(userId, playlistName, tracksToSave);
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("💾 Queue Saved to Playlist")
        .setDescription(
          `Saved **${res.addedCount}** new tracks from the current queue into **${playlistName}**!\nTotal songs in playlist: **${res.totalTracks}**`
        )
        .setFooter({ text: `Stream anytime using /playlist play name:${playlistName}` });

      return interaction.reply({ embeds: [embed] });
    }

    // 7. /playlist play <name>
    if (subcommand === "play") {
      const name = interaction.options.getString("name", true).trim();
      const playlist = getPlaylist(userId, name);
      if (!playlist || playlist.tracks.length === 0) {
        return interaction.reply({
          content: `❌ Playlist **${name}** was not found or is empty!`,
          ephemeral: true,
        });
      }

      await interaction.deferReply();

      const { player, error } = await getOrCreatePlayer(interaction);
      if (error || !player) {
        await interaction.editReply(error || "❌ Failed to connect to voice channel.");
        return;
      }

      await interaction.editReply(`🔍 Loading **${playlist.tracks.length}** songs from **${playlist.name}**...`);

      let queuedCount = 0;
      let firstTrackStarted = false;

      // Purge any existing autoplay prefetch so user's playlist takes 100% priority
      purgeAutoplayTracks(player);

      // Fast concurrent batch resolver (batches of 5)
      const BATCH_SIZE = 5;
      for (let i = 0; i < playlist.tracks.length; i += BATCH_SIZE) {
        const batch = playlist.tracks.slice(i, i + BATCH_SIZE);
        const resolvedBatch = await Promise.all(
          batch.map(async (t) => {
            try {
              let res = await player.search({ query: t.uri }, interaction.user);
              if (!res?.tracks?.length) {
                res = await smartSearch(player, `${t.title} ${t.author}`, false, interaction.user);
              }
              if (res?.tracks?.length) {
                const trk = res.tracks[0];
                trk.requester = interaction.user;
                return trk;
              }
            } catch {}
            return null;
          })
        );

        for (const trk of resolvedBatch) {
          if (trk) {
            await player.queue.add(trk);
            queuedCount++;

            // Start audio immediately on the very first track so user hears music in < 500ms
            if (!firstTrackStarted && !player.playing && !player.paused) {
              firstTrackStarted = true;
              await player.play();
            }
          }
        }
      }

      if (queuedCount === 0) {
        await interaction.editReply(`❌ Failed to resolve tracks from playlist **${playlist.name}**.`);
        autoDeleteReply(interaction, 8000);
        return;
      }

      if (!firstTrackStarted && !player.playing && !player.paused) {
        await player.play();
      } else {
        await updateActivePlayerMessage(player);
      }

      const totalMs = playlist.tracks.reduce((acc, t) => acc + (t.duration || 0), 0);

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle(`🎶 Playing Playlist: ${playlist.name}`)
        .setDescription(`Successfully queued **${queuedCount}** songs (\`${formatDuration(totalMs)}\`) into the queue!`)
        .setFooter({ text: "South Conclave Custom Playlist Engine" });

      await interaction.editReply({ content: "", embeds: [embed] });
      autoDeleteReply(interaction, 12000);
    }
  },
};
