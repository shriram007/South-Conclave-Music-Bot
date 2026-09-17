import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { EQ_PRESETS } from "../utils/equalizer.js";

export const filterCommand = {
  data: new SlashCommandBuilder()
    .setName("filter")
    .setDescription("Apply studio sound filters and equalizer presets")
    .addStringOption((opt) =>
      opt
        .setName("preset")
        .setDescription("Select an audio preset")
        .setRequired(true)
        .addChoices(
          { name: "💎 Hi-Fi Studio (Audiophile Clarity & Sparkle)", value: "hifi" },
          { name: "🔊 Bass Boost (Punchy Deep Low-End)", value: "bassboost" },
          { name: "🎤 Vocal / Treble Boost (Crisp Highs)", value: "treble" },
          { name: "🎧 8D Audio (Rotating Binaural Effect)", value: "8d" },
          { name: "⚡ Nightcore (Fast Tempo & Pitch)", value: "nightcore" },
          { name: "🌊 Vaporwave (Slowed & Relaxed)", value: "vaporwave" },
          { name: "🔄 Reset to Flat / Pure Audio", value: "reset" }
        )
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

    const preset = interaction.options.getString("preset", true);
    await interaction.deferReply();

    try {
      switch (preset) {
        case "hifi":
          player.setData("hifi_active", true);
          player.setData("eq_preset", "💎 Hi-Fi Studio");
          await player.filterManager.setEQ(EQ_PRESETS.hifi);
          await updateActivePlayerMessage(player);
          return interaction.editReply("💎 **Hi-Fi Studio Preset Applied!** Enhanced dynamics, tighter bass, and crystal clear highs.\n*(Updated Now Playing card)*");

        case "bassboost":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🔊 Bass Boost");
          await player.filterManager.setEQ(EQ_PRESETS.bassboost);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🔊 **Bass Boost Applied!** Deep, powerful sub-bass active.\n*(Updated Now Playing card)*");

        case "treble":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎤 Treble Boost");
          await player.filterManager.setEQ(EQ_PRESETS.treble);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🎤 **Treble Boost Applied!** Vocals and acoustic detail emphasized.\n*(Updated Now Playing card)*");

        case "8d":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎧 8D Audio");
          await player.filterManager.clearEQ();
          await player.filterManager.toggleRotation(0.3);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🎧 **8D Rotating Audio Active!** Use headphones for the full 360° effect.\n*(Updated Now Playing card)*");

        case "nightcore":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "⚡ Nightcore");
          await player.filterManager.clearEQ();
          await player.filterManager.toggleNightcore();
          await updateActivePlayerMessage(player);
          return interaction.editReply("⚡ **Nightcore Mode Active!** High energy pitch & speed increased.\n*(Updated Now Playing card)*");

        case "vaporwave":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🌊 Vaporwave");
          await player.filterManager.clearEQ();
          await player.filterManager.toggleVaporwave();
          await updateActivePlayerMessage(player);
          return interaction.editReply("🌊 **Vaporwave Mode Active!** Slowed, dreamy aesthetic filter applied.\n*(Updated Now Playing card)*");

        case "reset":
        default:
          player.setData("hifi_active", false);
          player.setData("eq_preset", "Normal (Flat)");
          await player.filterManager.resetFilters();
          await player.filterManager.clearEQ();
          await updateActivePlayerMessage(player);
          return interaction.editReply("🔄 **Equalizer Reset!** Streaming flat, pure master audio.\n*(Updated Now Playing card)*");
      }
    } catch (err: any) {
      console.error("[Filter Command] Error:", err);
      return interaction.editReply(`⚠️ Failed to apply filter: ${err.message || "Unknown error"}`);
    }
  },
};
