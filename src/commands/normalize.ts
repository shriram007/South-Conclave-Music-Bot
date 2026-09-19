import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { clearAllFilters, lavalink, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";

/**
 * Applies or removes loudness normalization filter on a player
 */
export async function applyLoudnessNormalization(player: any, enable: boolean): Promise<boolean> {
  const manager = player.filterManager;
  const active = Boolean(manager?.filters?.lavalinkLavaDspxPlugin?.normalization);
  if (enable && !player.node?.info?.filters?.includes("normalization")) {
    player.setData("normalized", false);
    return false;
  }
  try {
    if (active !== enable) {
      await manager.lavalinkLavaDspxPlugin.toggleNormalization(0.85, true);
    }
    player.setData("normalized", enable);
    return true;
  } catch (err) {
    console.warn("[Normalization] Filter update failed:", err);
    return false;
  }
}

export const normalizeCommand = {
  data: new SlashCommandBuilder()
    .setName("normalize")
    .setDescription("Toggle adaptive loudness normalization when supported by the audio node")
    .addBooleanOption((opt) =>
      opt
        .setName("enabled")
        .setDescription("Turn automatic loudness leveling ON or OFF")
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player) {
      return interaction.reply({
        content: "❌ No music is actively playing in this server!",
        ephemeral: true,
      });
    }

    const gate = await validateVoiceGate(interaction, player);
    if (!gate.allowed) {
      return interaction.reply({ content: gate.error!, ephemeral: true });
    }

    const currentStatus = Boolean(player.getData("normalized") ?? false);
    const targetStatus = interaction.options.getBoolean("enabled") ?? !currentStatus;

    await interaction.deferReply();
    if (!await applyLoudnessNormalization(player, targetStatus)) {
      await interaction.editReply("⚠️ Normalization could not be applied. The connected audio node must support the normalization filter.");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(targetStatus ? 0x00d26a : 0x5865f2)
      .setTitle(targetStatus ? "🔊 Loudness Normalization Enabled" : "🔇 Loudness Normalization Disabled")
      .setDescription(
        targetStatus
          ? "✅ **Adaptive normalization active:**\n" +
            "The audio node applies adaptive amplitude normalization. This is not measured ReplayGain or a fixed LUFS target."
          : "ℹ️ **Normalization disabled:**\nTracks will stream at their original uploaded volume levels."
      )
      .setFooter({ text: "South Conclave Audio Engine • Normalization" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    autoDeleteReply(interaction, 12000);
  },
};
