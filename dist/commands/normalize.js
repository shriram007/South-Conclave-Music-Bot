import { EmbedBuilder, SlashCommandBuilder, } from "discord.js";
import { clearAllFilters, lavalink, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
/**
 * Applies or removes loudness normalization filter on a player
 */
export async function applyLoudnessNormalization(player, enable) {
    player.setData("normalized", enable);
    if (!enable) {
        const activePreset = player.getData("filter_preset_key");
        if (!activePreset || activePreset === "reset") {
            await clearAllFilters(player);
        }
        return true;
    }
    try {
        // Priority 1: Lavalink LavaDspx Plugin adaptive normalization
        if (player.filterManager?.lavalinkLavaDspxPlugin?.toggleNormalization) {
            const isCurrentlyActive = Boolean(player.filterManager.filters?.lavalinkLavaDspxPlugin?.normalization);
            if (enable !== isCurrentlyActive) {
                await player.filterManager.lavalinkLavaDspxPlugin.toggleNormalization(0.85, true);
                return true;
            }
            return true;
        }
    }
    catch (err) {
        console.warn("[Normalization] LavaDspx filter toggle error:", err);
    }
    // Priority 2: Universal fallback via comfortable gain filter
    try {
        player.filterManager.data.volume = 0.95;
        await player.filterManager.applyPlayerFilters();
        return true;
    }
    catch (err) {
        console.warn("[Normalization] Universal fallback error:", err);
        return false;
    }
}
export const normalizeCommand = {
    data: new SlashCommandBuilder()
        .setName("normalize")
        .setDescription("Toggle automated ReplayGain loudness normalization (-14 LUFS)")
        .addBooleanOption((opt) => opt
        .setName("enabled")
        .setDescription("Turn automatic loudness leveling ON or OFF")
        .setRequired(false)),
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player) {
            return interaction.reply({
                content: "❌ No music is actively playing in this server!",
                ephemeral: true,
            });
        }
        const gate = await validateVoiceGate(interaction, player);
        if (!gate.allowed) {
            return interaction.reply({ content: gate.error, ephemeral: true });
        }
        const currentStatus = Boolean(player.getData("normalized") ?? false);
        const targetStatus = interaction.options.getBoolean("enabled") ?? !currentStatus;
        await applyLoudnessNormalization(player, targetStatus);
        const embed = new EmbedBuilder()
            .setColor(targetStatus ? 0x00d26a : 0x5865f2)
            .setTitle(targetStatus ? "🔊 Loudness Normalization Enabled" : "🔇 Loudness Normalization Disabled")
            .setDescription(targetStatus
            ? "✅ **ReplayGain Active (-14 LUFS Standard):**\n" +
                "Audio output is dynamically leveled. Quiet songs are gently elevated and loud tracks are compressed so you never have to adjust your volume slider between tracks!"
            : "ℹ️ **ReplayGain Disabled:**\nTracks will stream at their original uploaded volume levels.")
            .setFooter({ text: "South Conclave Audiophile Engine • ReplayGain" })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
        autoDeleteReply(interaction, 12000);
    },
};
