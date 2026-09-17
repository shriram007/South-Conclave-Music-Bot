import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextChannel,
} from "discord.js";
import { activePlayerMessages, lavalink } from "../lavalink/client.js";

export const cleanCommand = {
  data: new SlashCommandBuilder()
    .setName("clean")
    .setDescription("Clear past bot messages and temporary chat history from this channel")
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("Number of recent messages to check and clean (1 to 100, default: 30)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.channel || !("messages" in interaction.channel)) {
      return interaction.reply({ content: "❌ This command can only be used in a server text channel.", ephemeral: true });
    }

    const channel = interaction.channel as TextChannel;
    const amount = interaction.options.getInteger("amount") || 30;

    await interaction.deferReply({ ephemeral: true });

    try {
      const messages = await channel.messages.fetch({ limit: amount });
      const botId = interaction.client.user.id;
      const activeMessageId = activePlayerMessages.get(interaction.guildId || "");
      const player = lavalink.getPlayer(interaction.guildId || "");
      const isMusicActive = Boolean(player && (player.playing || player.paused || player.queue.current));

      // Find bot messages to clean up while strictly preserving music player cards
      const messagesToDelete = messages.filter((m) => {
        if (m.author.id !== botId) return false;

        // 1. NEVER delete the active player card
        if (activeMessageId && m.id === activeMessageId) return false;
        if (player && player.getData("active_message_id") === m.id) return false;

        // 2. NEVER delete interactive components (player cards, buttons, select menus)
        if (m.components && m.components.length > 0) return false;

        // 3. NEVER delete player embeds or currently playing song cards
        const isPlayerOrMusicEmbed = m.embeds.some((e) => {
          const author = e.author?.name?.toLowerCase() || "";
          const title = e.title?.toLowerCase() || "";
          const desc = e.description?.toLowerCase() || "";
          const footer = e.footer?.text?.toLowerCase() || "";
          return (
            author.includes("playing") ||
            author.includes("paused") ||
            title.includes("playing") ||
            title.includes("added to queue") ||
            desc.includes("added by") ||
            footer.includes("south conclave") ||
            footer.includes("interactive player")
          );
        });
        if (isPlayerOrMusicEmbed) return false;

        // 4. While music is actively playing, preserve recently sent music confirmation cards
        if (isMusicActive) {
          const ageMs = Date.now() - m.createdTimestamp;
          if (ageMs < 10 * 60 * 1000 && m.embeds.length > 0) return false;
        }

        return true;
      });

      if (messagesToDelete.size === 0) {
        return interaction.editReply("✨ No past bot messages found to clean up.");
      }

      // Try bulk delete (works for messages < 14 days old)
      try {
        await channel.bulkDelete(messagesToDelete, true);
      } catch {
        // Fallback: delete individually
        for (const msg of messagesToDelete.values()) {
          await msg.delete().catch(() => {});
        }
      }

      return interaction.editReply(`🧹 Cleaned up **${messagesToDelete.size}** past bot message(s) from chat.`);
    } catch (err: any) {
      console.error("[Clean Command] Error:", err);
      return interaction.editReply(`⚠️ Failed to clean messages: ${err.message || "Unknown error"}`);
    }
  },
};
