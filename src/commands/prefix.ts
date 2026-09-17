import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { getPrefix, setPrefix } from "../utils/prefixes.js";

export const prefixCommand = {
  data: new SlashCommandBuilder()
    .setName("prefix")
    .setDescription("View or change the bot text prefix for this server (Admin only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set a new prefix for this server (e.g. !, ?, +, m!)")
        .addStringOption((opt) =>
          opt
            .setName("symbol")
            .setDescription("New prefix symbol (max 5 characters)")
            .setMaxLength(5)
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("view").setDescription("View the current prefix for this server")
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) {
      return interaction.reply({ content: "❌ This command can only be used in a server!", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "view") {
      const current = getPrefix(guildId);
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("⚙️ Server Prefix Settings")
        .setDescription(`The current prefix for **${interaction.guild?.name}** is: \`${current}\`\n\nExample usage: \`${current}play Never Gonna Give You Up\``)
        .setFooter({ text: "Administrators can change this using /prefix set <new_prefix>" });

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === "set") {
      // Check admin permission
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: "❌ You need **Manage Server** or **Administrator** permission to change the prefix!",
          ephemeral: true,
        });
      }

      const newPrefix = interaction.options.getString("symbol", true).trim();
      if (!newPrefix || newPrefix.length > 5) {
        return interaction.reply({
          content: "❌ Prefix must be between 1 and 5 characters!",
          ephemeral: true,
        });
      }

      setPrefix(guildId, newPrefix);

      const embed = new EmbedBuilder()
        .setColor(0x00d26a)
        .setTitle("✅ Prefix Updated Successfully")
        .setDescription(
          `The server prefix for **${interaction.guild?.name}** has been set to: \`${newPrefix}\`\n\n` +
          `You can now use commands like:\n` +
          `• \`${newPrefix}play <song>\`\n` +
          `• \`${newPrefix}skip\`\n` +
          `• \`${newPrefix}queue\`\n` +
          `• \`${newPrefix}stop\``
        );

      return interaction.reply({ embeds: [embed] });
    }
  },
};
