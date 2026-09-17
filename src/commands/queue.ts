import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { formatDuration, getSourceInfo } from "../utils/formatters.js";

export const queueCommand = {
  data: new SlashCommandBuilder()
    .setName("queue")
    .setDescription("View the current music queue")
    .addIntegerOption((opt) =>
      opt.setName("page").setDescription("Queue page number").setMinValue(1)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
      return interaction.reply({ content: "❌ Nothing is currently playing or queued.", ephemeral: true });
    }

    const current = player.queue.current;
    const tracks = player.queue.tracks;
    const page = (interaction.options.getInteger("page") || 1) - 1;
    const pageSize = 10;
    const totalPages = Math.ceil(tracks.length / pageSize) || 1;

    if (page >= totalPages) {
      return interaction.reply({
        content: `❌ Invalid page. Total pages: ${totalPages}`,
        ephemeral: true,
      });
    }

    const startIdx = page * pageSize;
    const pageTracks = tracks.slice(startIdx, startIdx + pageSize);

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎶 Server Music Queue");

    if (current) {
      const src = getSourceInfo(current.info.sourceName);
      const reqName = current.requester ? ` • Req: **${(current.requester as any).displayName || (current.requester as any).username || "Member"}**` : "";
      embed.setDescription(
        `**Now Playing:**\n` +
        `🎵 **[${current.info.title}](${current.info.uri})**\n` +
        `By: **${current.info.author}** | \`${formatDuration(player.position)} / ${formatDuration(current.info.duration)}\`${reqName}\n` +
        `Fidelity: ${src.badge}\n` +
        `─────────────────────────────\n` +
        `**Up Next:**`
      );
    }

    if (pageTracks.length === 0) {
      embed.addFields([{ name: "Queue", value: "No more tracks in queue. Add more using `/play`!" }]);
    } else {
      const list = pageTracks
        .map((t, i) => {
          const index = startIdx + i + 1;
          const reqName = t.requester ? ` • Req: **${(t.requester as any).displayName || (t.requester as any).username || "Member"}**` : "";
          return `\`${index}.\` [${t.info.title.substring(0, 40)}](${t.info.uri}) - \`${formatDuration(t.info.duration || 0)}\`${reqName}`;
        })
        .join("\n");

      embed.addFields([{ name: `Tracks (${startIdx + 1}-${startIdx + pageTracks.length} of ${tracks.length})`, value: list }]);
    }

    const totalDuration = player.queue.utils.totalDuration();
    embed.setFooter({
      text: `Page ${page + 1}/${totalPages} | Total queue time: ${formatDuration(totalDuration)} | Volume: ${player.volume}%`,
    });

    return interaction.reply({ embeds: [embed] });
  },
};
