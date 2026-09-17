import { SlashCommandBuilder, } from "discord.js";
import { lavalink, updateActivePlayerMessage, validateVoiceGate } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
export const volumeCommand = {
    data: new SlashCommandBuilder()
        .setName("volume")
        .setDescription("Adjust the playback volume (0% - 200%)")
        .addIntegerOption((opt) => opt
        .setName("level")
        .setDescription("Volume percentage (0 to 200)")
        .setMinValue(0)
        .setMaxValue(200)
        .setRequired(true)),
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player) {
            return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
        }
        const gate = await validateVoiceGate(interaction, player);
        if (!gate.allowed) {
            return interaction.reply({ content: gate.error, ephemeral: true });
        }
        const vol = interaction.options.getInteger("level", true);
        await player.setVolume(vol);
        await updateActivePlayerMessage(player);
        let icon = "🔊";
        if (vol === 0)
            icon = "🔇";
        else if (vol < 50)
            icon = "🔉";
        await interaction.reply(`${icon} Volume adjusted to **${vol}%**`);
        autoDeleteReply(interaction, 8000);
    },
};
