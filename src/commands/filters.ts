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
          { name: "💥 Nuclear Bass (Extreme Ear-Rattling Sub)", value: "nuclear" },
          { name: "🎤 Vocal / Treble Boost (Crisp Highs)", value: "treble" },
          { name: "🎧 8D Audio (Rotating Binaural Effect)", value: "8d" },
          { name: "⚡ Nightcore (Fast Tempo & High Pitch)", value: "nightcore" },
          { name: "🌊 Vaporwave (Slowed & Relaxed)", value: "vaporwave" },
          { name: "🐿️ Chipmunk (Funny High-Pitched Vocals)", value: "chipmunk" },
          { name: "👺 Darth Vader / Demon (Deep Voice Shift)", value: "darthvader" },
          { name: "🚪 Next Room / Party in the Hallway (Muffled)", value: "muffled" },
          { name: "☎️ 1920s Old Radio / Telephone", value: "radio" },
          { name: "🤿 Underwater (Submerged Bubbly Tone)", value: "underwater" },
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
      // Clear previous filters before applying new one to prevent conflicts
      await player.filterManager.resetFilters();
      await player.filterManager.clearEQ();

      switch (preset) {
        case "hifi":
          player.setData("hifi_active", true);
          player.setData("eq_preset", "💎 Hi-Fi Studio");
          await player.filterManager.setEQ(EQ_PRESETS.hifi);
          await updateActivePlayerMessage(player);
          return interaction.editReply("💎 **Hi-Fi Studio Applied!** Enhanced dynamics and crystal sparkle.");

        case "bassboost":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🔊 Bass Boost");
          await player.filterManager.setEQ(EQ_PRESETS.bassboost);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🔊 **Bass Boost Applied!** Deep, punchy sub-bass active.");

        case "nuclear":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "💥 Nuclear Bass");
          await player.filterManager.setEQ(EQ_PRESETS.nuclear);
          await updateActivePlayerMessage(player);
          return interaction.editReply("💥 **Nuclear Bass Active!** Max sub-woofer rumble activated.");

        case "treble":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎤 Treble Boost");
          await player.filterManager.setEQ(EQ_PRESETS.treble);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🎤 **Treble Boost Applied!** Vocals and acoustic detail emphasized.");

        case "8d":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🎧 8D Audio");
          await player.filterManager.toggleRotation(0.35);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🎧 **8D Audio Active!** Rotating 360° binaural effect — wear headphones!");

        case "nightcore":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "⚡ Nightcore");
          await player.filterManager.toggleNightcore();
          await updateActivePlayerMessage(player);
          return interaction.editReply("⚡ **Nightcore Active!** Speed and pitch boosted.");

        case "vaporwave":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🌊 Vaporwave");
          await player.filterManager.toggleVaporwave();
          await updateActivePlayerMessage(player);
          return interaction.editReply("🌊 **Vaporwave Active!** Slowed, dreamy aesthetic tone.");

        case "chipmunk":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🐿️ Chipmunk");
          await player.filterManager.setSpeed(1.2);
          await player.filterManager.setPitch(1.35);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🐿️ **Chipmunk Mode Active!** High-pitched squeaky vocals.");

        case "darthvader":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "👺 Darth Vader");
          await player.filterManager.setSpeed(0.92);
          await player.filterManager.setPitch(0.68);
          await updateActivePlayerMessage(player);
          return interaction.editReply("👺 **Darth Vader Active!** Deep, ominous orator voice pitch.");

        case "muffled":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🚪 Next Room");
          await player.filterManager.setEQ(EQ_PRESETS.nextdoor);
          await player.filterManager.toggleLowPass(25);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🚪 **Next Room Mode Active!** Sounds like listening from the hallway outside.");

        case "radio":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "☎️ Vintage Radio");
          await player.filterManager.setEQ(EQ_PRESETS.radio);
          await updateActivePlayerMessage(player);
          return interaction.editReply("☎️ **1920s Telephone / Radio Active!** Vintage lo-fi sound.");

        case "underwater":
          player.setData("hifi_active", false);
          player.setData("eq_preset", "🤿 Underwater");
          await player.filterManager.setEQ(EQ_PRESETS.nextdoor);
          await player.filterManager.toggleTremolo(4.0, 0.6);
          await updateActivePlayerMessage(player);
          return interaction.editReply("🤿 **Underwater Mode Active!** Bubbly, submerged acoustic simulation.");

        case "reset":
        default:
          player.setData("hifi_active", false);
          player.setData("eq_preset", "Normal (Flat)");
          await updateActivePlayerMessage(player);
          return interaction.editReply("🔄 **Equalizer Reset!** Streaming flat, pure master audio.");
      }
    } catch (err: any) {
      console.error("[Filter Command] Error:", err);
      return interaction.editReply(`⚠️ Failed to apply filter: ${err.message || "Unknown error"}`);
    }
  },
};
