import { purgeAutoplayTracks } from "../lavalink/client.js";
import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";

export const autoplayCommand = {
  data: new SlashCommandBuilder()
    .setName("autoplay")
    .setDescription("Toggle Smart Autoplay (Spotify-style infinite radio when queue ends)")
    .addStringOption((opt) =>
      opt
        .setName("mode")
        .setDescription("Turn autoplay on or off")
        .setRequired(false)
        .addChoices(
          { name: "On (Infinite Radio)", value: "on" },
          { name: "Off (Stop when queue ends)", value: "off" }
        )
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player) {
      await interaction.reply({ content: "❌ No music player active in this server.", ephemeral: true });
      return;
    }

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      await interaction.reply({ content: gate.error!, ephemeral: true });
      return;
    }

    const modeOpt = interaction.options.getString("mode");
    const currentAutoplay = Boolean(player.getData("autoplay") ?? true);
    const newAutoplay = modeOpt ? modeOpt === "on" : !currentAutoplay;

    player.setData("autoplay", newAutoplay);
    if (!newAutoplay) purgeAutoplayTracks(player);
    await updateActivePlayerMessage(player, true);

    await interaction.reply(
      newAutoplay
        ? "📻 **Smart Autoplay Enabled!** When the queue finishes, similar songs will play automatically like Spotify Radio."
        : "⏸️ **Smart Autoplay Disabled.** Playback will stop once the current queue finishes."
    );
    autoDeleteReply(interaction, 8000);
  },
};
