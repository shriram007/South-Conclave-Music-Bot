import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  SlashCommandBuilder,
} from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { getChannelBitrateInfo, getSourceInfo } from "../utils/formatters.js";

export const qualityCommand = {
  data: new SlashCommandBuilder()
    .setName("quality")
    .setDescription("Inspect audio bitrate, server boost tier, and studio playback fidelity"),

  async execute(interaction: ChatInputCommandInteraction) {
    const member = interaction.member as GuildMember | null;
    const voiceChannel = interaction.guild?.members.me?.voice.channel || member?.voice?.channel;

    const player = lavalink.getPlayer(interaction.guildId!);
    const current = player?.queue.current;
    const currentSrc = current ? getSourceInfo(current.info.sourceName, current.info.uri, current.userData) : null;

    const embed = new EmbedBuilder()
      .setColor(0x00d26a)
      .setTitle("💎 Studio Audio Quality & Bitrate Inspector")
      .setDescription(
        "Source quality, audio-node settings, and the Discord voice channel all affect playback. Catalog search does not verify stream bitrate or lossless audio."
      );

    if (voiceChannel) {
      const info = getChannelBitrateInfo(voiceChannel);
      embed.addFields([
        {
          name: "🔊 Current Voice Channel Bitrate",
          value: `**${info.bitrateKbps} kbps** (${info.tier})`,
          inline: true,
        },
        {
          name: "🎯 Maximum Bitrate For Server",
          value: info.isMaxQuality ? "✅ **Set to Maximum**" : "⚠️ **Can be increased**",
          inline: true,
        },
      ]);

      embed.addFields([
        {
          name: "💡 Optimization Tip",
          value: info.recommendation,
          inline: false,
        },
      ]);
    } else {
      embed.addFields([
        {
          name: "🔊 Voice Channel",
          value: "Connect to a voice channel to inspect its exact live bitrate.",
          inline: false,
        },
      ]);
    }

    // Engine & Source Specs
    embed.addFields([
      {
        name: "🎛️ Audio Engine Pipeline",
        value:
          `• **Node:** ${player?.node?.id || "Not connected"}\n` +
          `• **EQ:** ${player?.getData("eq_preset") || "Normal (Flat)"}\n` +
          `• **Normalization:** ${player?.getData("normalized") ? "Enabled" : "Off"}\n` +
          "• Encoder quality and buffering are controlled by the audio node.\n" +
          "• Source codec and bitrate are not exposed by standard track metadata.",
        inline: false,
      },
      {
        name: "🎵 Current Track Source",
        value: currentSrc
          ? `${currentSrc.badge}\n• Stream Rate: **${currentSrc.quality}**`
          : "No track currently playing. Use `/play` to start.",
        inline: false,
      },
      {
        name: "🚀 Discord Server Boost Bitrate Tiers",
        value:
          "• **Free / Standard:** Up to `96 kbps`\n" +
          "• **Tier 1 (2 Boosts):** Up to `128 kbps`\n" +
          "• **Tier 2 (7 Boosts):** Up to `256 kbps`\n" +
          "• **Tier 3 (14 Boosts) / Partnered:** Up to `384 kbps` ",
        inline: false,
      },
    ]);

    if (current) {
      embed.addFields({ name: "Recording identity", value:
        `Playing ID: \`${current.info.identifier}\`` +
        ((current.userData as any)?.requestedVideoId ? `\nRequested video: \`${(current.userData as any).requestedVideoId}\`` : ""), inline: false });
    }
    const youtubePlugin = player?.node?.info?.plugins?.find(p => /youtube/i.test(p.name));
    if (youtubePlugin) embed.addFields({ name: "YouTube source plugin", value: `${youtubePlugin.name} ${youtubePlugin.version}`, inline: false });

    embed.setFooter({
      text: "How to increase bitrate: Right click Voice Channel → Edit Channel → Overview → Bitrate slider",
    });

    return interaction.reply({ embeds: [embed] });
  },
};
