import { SlashCommandBuilder, } from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
export const filterCommand = {
    data: new SlashCommandBuilder()
        .setName("filter")
        .setDescription("Apply studio sound filters and equalizer presets")
        .addStringOption((opt) => opt
        .setName("preset")
        .setDescription("Select an audio preset")
        .setRequired(true)
        .addChoices({ name: "💎 Hi-Fi Studio (Audiophile Clarity & Sparkle)", value: "hifi" }, { name: "🔊 Bass Boost (Punchy Deep Low-End)", value: "bassboost" }, { name: "💥 Nuclear Bass (Extreme Sub Rumble)", value: "nuclear" }, { name: "🎤 Vocal / Treble Boost (Crisp Highs)", value: "treble" }, { name: "🎧 8D Audio (Rotating Binaural Immersion)", value: "8d" }, { name: "⚡ Nightcore (Fast Tempo & High Pitch)", value: "nightcore" }, { name: "🌊 Vaporwave (Slowed & Relaxed)", value: "vaporwave" }, { name: "🎤 Karaoke (Vocal Reducer / Sing-Along)", value: "karaoke" }, { name: "🔄 Reset to Flat / Pure Audio", value: "reset" })),
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player) {
            return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
        }
        const gate = await validateVoiceGate(interaction, player);
        if (!gate.allowed) {
            return interaction.reply({ content: gate.error, ephemeral: true });
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
                case "karaoke":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎤 Karaoke");
                    await player.filterManager.toggleKaraoke(1, 1, 220, 100);
                    await updateActivePlayerMessage(player);
                    return interaction.editReply("🎤 **Karaoke Mode Active!** Center lead vocals dampened for sing-along.");
                case "reset":
                default:
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "Normal (Flat)");
                    await updateActivePlayerMessage(player);
                    return interaction.editReply("🔄 **Equalizer Reset!** Streaming flat, pure master audio.");
            }
        }
        catch (err) {
            console.error("[Filter Command] Error:", err);
            return interaction.editReply(`⚠️ Failed to apply filter: ${err.message || "Unknown error"}`);
        }
    },
};
