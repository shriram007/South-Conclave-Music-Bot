import { SlashCommandBuilder, } from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { buildQueueMessage } from "../lavalink/queueUI.js";
export const queueCommand = {
    data: new SlashCommandBuilder()
        .setName("queue")
        .setDescription("View and interactively manage the current music queue")
        .addIntegerOption((opt) => opt.setName("page").setDescription("Queue page number").setMinValue(1)),
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player || (!player.queue.current && player.queue.tracks.length === 0)) {
            return interaction.reply({ content: "❌ Nothing is currently playing or queued.", ephemeral: true });
        }
        const pageInput = (interaction.options.getInteger("page") || 1) - 1;
        const queueMsg = buildQueueMessage(player, pageInput, 0, interaction.user.username);
        return interaction.reply(queueMsg);
    },
};
