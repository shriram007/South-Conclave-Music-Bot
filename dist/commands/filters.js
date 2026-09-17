import { SlashCommandBuilder, } from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { EQ_PRESETS } from "../utils/equalizer.js";
export const filterCommand = {
    data: new SlashCommandBuilder()
        .setName("filter")
        .setDescription("Apply studio sound filters and equalizer presets")
        .addStringOption((opt) => opt
        .setName("preset")
        .setDescription("Select an audio preset")
        .setRequired(true)
        .addChoices({ name: "💎 Hi-Fi Studio (Audiophile Clarity & Sparkle)", value: "hifi" }, { name: "🔊 Bass Boost (Punchy Deep Low-End)", value: "bassboost" }, { name: "🏎️ Turbo Rush (1.35x High Energy Tempo)", value: "turbo" }, { name: "🎤 Vocal / Treble Boost (Crisp Highs)", value: "treble" }, { name: "🎧 8D Audio (Rotating Binaural Immersion)", value: "8d" }, { name: "⚡ Nightcore (Fast Tempo & High Pitch)", value: "nightcore" }, { name: "🌊 Vaporwave (Slowed & Relaxed)", value: "vaporwave" }, { name: "🎤 Karaoke (Vocal Reducer / Sing-Along)", value: "karaoke" }, { name: "🔄 Reset to Flat / Pure Audio", value: "reset" })),
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
            player.setData("filter_preset_key", preset);
            let replyText = "🔄 **Equalizer Reset!** Streaming flat, pure master audio.";
            switch (preset) {
                case "hifi":
                    player.setData("hifi_active", true);
                    player.setData("eq_preset", "💎 Hi-Fi Studio");
                    await player.filterManager.setEQ(EQ_PRESETS.hifi);
                    replyText = "💎 **Hi-Fi Studio Applied!** Enhanced dynamics and crystal sparkle.";
                    break;
                case "bassboost":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🔊 Bass Boost");
                    await player.filterManager.setEQ(EQ_PRESETS.bassboost);
                    replyText = "🔊 **Bass Boost Applied!** Deep, punchy sub-bass active.";
                    break;
                case "turbo":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🏎️ Turbo Rush");
                    await player.filterManager.setSpeed(1.35);
                    replyText = "🏎️ **Turbo Rush Applied!** 1.35x high-energy tempo boost.";
                    break;
                case "treble":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎤 Treble Boost");
                    await player.filterManager.setEQ(EQ_PRESETS.treble);
                    replyText = "🎤 **Treble Boost Applied!** Vocals and acoustic detail emphasized.";
                    break;
                case "8d":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎧 8D Audio");
                    await player.filterManager.toggleRotation(0.35);
                    replyText = "🎧 **8D Audio Active!** Rotating 360° binaural effect — wear headphones!";
                    break;
                case "nightcore":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "⚡ Nightcore");
                    await player.filterManager.toggleNightcore();
                    replyText = "⚡ **Nightcore Active!** Speed and pitch boosted.";
                    break;
                case "vaporwave":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🌊 Vaporwave");
                    await player.filterManager.toggleVaporwave();
                    replyText = "🌊 **Vaporwave Active!** Slowed, dreamy aesthetic tone.";
                    break;
                case "karaoke":
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "🎤 Karaoke");
                    await player.filterManager.toggleKaraoke(1, 1, 220, 100);
                    replyText = "🎤 **Karaoke Mode Active!** Center lead vocals dampened for sing-along.";
                    break;
                case "reset":
                default:
                    player.setData("hifi_active", false);
                    player.setData("eq_preset", "Normal (Flat)");
                    replyText = "🔄 **Equalizer Reset!** Streaming flat, pure master audio.";
                    break;
            }
            await updateActivePlayerMessage(player);
            await interaction.editReply(replyText);
            autoDeleteReply(interaction, 8000);
        }
        catch (err) {
            console.error("[Filter Command] Error:", err);
            await interaction.editReply(`⚠️ Failed to apply filter: ${err.message || "Unknown error"}`);
            autoDeleteReply(interaction, 8000);
        }
    },
};
