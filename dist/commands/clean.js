import { SlashCommandBuilder, } from "discord.js";
import { activePlayerMessages } from "../lavalink/client.js";
export const cleanCommand = {
    data: new SlashCommandBuilder()
        .setName("clean")
        .setDescription("Clear past bot messages and temporary chat history from this channel")
        .addIntegerOption((opt) => opt
        .setName("amount")
        .setDescription("Number of recent messages to check and clean (1 to 100, default: 30)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)),
    async execute(interaction) {
        if (!interaction.channel || !("messages" in interaction.channel)) {
            return interaction.reply({ content: "❌ This command can only be used in a server text channel.", ephemeral: true });
        }
        const channel = interaction.channel;
        const amount = interaction.options.getInteger("amount") || 30;
        await interaction.deferReply({ ephemeral: true });
        try {
            const messages = await channel.messages.fetch({ limit: amount });
            const botId = interaction.client.user.id;
            const activeMessageId = activePlayerMessages.get(interaction.guildId || "");
            // Find all bot messages in this channel EXCEPT the active live player embed
            const messagesToDelete = messages.filter((m) => {
                if (m.id === activeMessageId)
                    return false; // Preserve currently active player
                return m.author.id === botId;
            });
            if (messagesToDelete.size === 0) {
                return interaction.editReply("✨ No past bot messages found to clean up.");
            }
            // Try bulk delete (works for messages < 14 days old)
            try {
                await channel.bulkDelete(messagesToDelete, true);
            }
            catch {
                // Fallback: delete individually
                for (const msg of messagesToDelete.values()) {
                    await msg.delete().catch(() => { });
                }
            }
            return interaction.editReply(`🧹 Cleaned up **${messagesToDelete.size}** past bot message(s) from chat.`);
        }
        catch (err) {
            console.error("[Clean Command] Error:", err);
            return interaction.editReply(`⚠️ Failed to clean messages: ${err.message || "Unknown error"}`);
        }
    },
};
