import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { activePlayerMessages, lavalink } from "../lavalink/client.js";
import { buildPlayerMessage } from "../lavalink/playerUI.js";

export const nowplayingCommand = {
  data: new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Show the currently playing song with interactive controls"),

  async execute(interaction: ChatInputCommandInteraction) {
    const player = lavalink.getPlayer(interaction.guildId!);
    if (!player || !player.queue.current) {
      return interaction.reply({ content: "❌ Nothing is currently playing.", ephemeral: true });
    }

    const playerMsg = buildPlayerMessage(player);
    const reply = await interaction.reply({ ...playerMsg, fetchReply: true });
    activePlayerMessages.set(interaction.guildId!, reply.id);
    player.setData("active_message_id", reply.id);
  },
};
