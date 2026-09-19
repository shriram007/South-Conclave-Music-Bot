import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { formatDuration } from "../utils/formatters.js";

export const skiptoCommand = {
  data: new SlashCommandBuilder()
    .setName("skipto")
    .setDescription("Jump forward directly to a specific song in the queue")
    .addIntegerOption((opt) =>
      opt
        .setName("track")
        .setDescription("Select or enter the track number to jump to")
        .setRequired(true)
        .setMinValue(1)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction: AutocompleteInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || player.queue.tracks.length === 0) {
      return interaction.respond([]);
    }

    const focusedValue = interaction.options.getFocused().toLowerCase();
    const tracks = player.queue.tracks;

    const choices: { name: string; value: number }[] = [];
    for (let i = 0; i < tracks.length; i++) {
      if (choices.length >= 25) break;
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

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || !player.queue.current) {
      return interaction.reply({
        content: "❌ Nothing is currently playing in this server!",
        ephemeral: true,
      });
    }

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({ content: gate.error!, ephemeral: true });
    }

    const position = interaction.options.getInteger("track", true);
    if (position < 1 || position > player.queue.tracks.length) {
      return interaction.reply({
        content: `❌ Invalid track position! Please select a song between **1** and **${player.queue.tracks.length}**.`,
        ephemeral: true,
      });
    }

    const targetTrack = player.queue.tracks[position - 1];
    const skippedCount = position - 1;

    // Remove preceding tracks from queue so targetTrack becomes next
    if (skippedCount > 0) {
      player.queue.tracks.splice(0, skippedCount);
    }

    await player.skip();

    const embed = new EmbedBuilder()
      .setColor(0x1db954)
      .setTitle("⏭️ Skipped Forward in Queue")
      .setDescription(
        `Jumped ahead **${skippedCount} song(s)**.\nNow streaming: **[${targetTrack.info.title}](${targetTrack.info.uri})** by **${targetTrack.info.author}**`
      )
      .setFooter({ text: `Requested by ${interaction.user.displayName || interaction.user.username}` })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
    autoDeleteReply(interaction, 10000);
  },
};
