import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { clearAllFilters, lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";

export const volumeCommand = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Adjust the playback volume (0% - 125%)")
    .addIntegerOption((opt) =>
      opt
        .setName("level")
        .setDescription("Volume percentage (0 to 125. Recommended: 100 for studio quality)")
        .setMinValue(0)
        .setMaxValue(125)
        .setRequired(true)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player) {
      return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
    }

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({ content: gate.error!, ephemeral: true });
    }

    const vol = interaction.options.getInteger("level", true);
    await player.setVolume(vol);

    if (vol === 100) {
      const activePreset = player.getData("filter_preset_key") as string | undefined;
      if (!activePreset || activePreset === "reset") {
        await clearAllFilters(player);
      }
    }

    await updateActivePlayerMessage(player);

    let icon = "🔊";
    if (vol === 0) icon = "🔇";
    else if (vol < 50) icon = "🔉";

    let notice = "";
    if (vol > 100) {
      notice = "\n⚠️ *Note: Volumes above 100% can cause audio clipping on loud masters. 100% is the optimal studio standard.*";
    }

    await interaction.reply(`${icon} Volume adjusted to **${vol}%**${notice}`);
    autoDeleteReply(interaction, 8000);
  },
};
