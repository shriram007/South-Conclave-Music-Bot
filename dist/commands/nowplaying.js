import { SlashCommandBuilder, } from "discord.js";
import { activePlayerMessages, lavalink } from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";
export const nowplayingCommand = {
    data: new SlashCommandBuilder()
        .setName("nowplaying")
        .setDescription("Show the currently playing song with interactive controls"),
    async execute(interaction) {
        const player = lavalink.getPlayer(interaction.guildId);
        if (!player || !player.queue.current) {
            return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
        }
        const playerMsg = buildPlayerMessage(player);
        const oldMsgId = activePlayerMessages.get(interaction.guildId) || player.getData("active_message_id");
        const reply = await interaction.reply({ ...playerMsg, withResponse: true });
        const replyMsg = reply.resource?.message || (await interaction.fetchReply());
        activePlayerMessages.set(interaction.guildId, replyMsg.id);
        player.setData("active_message_id", replyMsg.id);
        // Delete the previous player card so there is only ever one active player card in chat
        if (oldMsgId && oldMsgId !== replyMsg.id && interaction.channel) {
            interaction.channel.messages.fetch(oldMsgId).then((m) => m?.delete().catch(() => { })).catch(() => { });
        }
    },
};
