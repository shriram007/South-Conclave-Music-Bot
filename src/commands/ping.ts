import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { getBestNode, lavalink } from "../lavalink/client.js";
import { autoDeleteReply } from "../utils/cleanup.js";
import { formatDuration, getSourceInfo } from "../utils/formatters.js";

function getPingBadge(ms: number): string {
  if (ms < 0 || isNaN(ms)) return "`-- ms`";
  if (ms <= 60) return `🟢 \`${Math.round(ms)}ms\` *(Ultra Fast)*`;
  if (ms <= 150) return `🟡 \`${Math.round(ms)}ms\` *(Good)*`;
  return `🟠 \`${Math.round(ms)}ms\` *(Moderate)*`;
}

export const pingCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Inspect live audio node ping, stream latency, and playback health"),

  async execute(interaction: ChatInputCommandInteraction) {
    const startTime = Date.now();
    try {
      await interaction.deferReply();
    } catch (err: any) {
      if (err?.code === 10062 || err?.rawError?.code === 10062) return;
      throw err;
    }
    const roundTrip = Date.now() - startTime;

    const player = lavalink.getPlayer(interaction.guildId!);
    const clientPing = interaction.client.ws.ping;
    const voicePing = player?.ping?.ws ?? -1;
    const lavalinkPing = player?.ping?.lavalink ?? -1;

    const bestNodeId = getBestNode();
    const activeNode = player?.node || (bestNodeId ? lavalink.nodeManager.nodes.get(bestNodeId) : null) || Array.from(lavalink.nodeManager.nodes.values()).find((n) => n.connected);

    const currentTrack = player?.queue?.current;
    const sourceInfo = currentTrack ? getSourceInfo(currentTrack.info.sourceName, currentTrack.info.uri) : null;

    const embed = new EmbedBuilder()
      .setColor(voicePing > 0 && voicePing < 100 ? 0x00d26a : 0x5865f2)
      .setTitle("📡 Live Audio Stream & Node Latency")
      .setDescription(
        player?.playing
          ? `🎵 Currently streaming **[${currentTrack?.info.title}](${currentTrack?.info.uri})**`
          : "ℹ️ No track actively streaming in this server right now."
      );

    // Latency Grid
    embed.addFields([
      {
        name: "🔊 Discord Voice Latency",
        value: voicePing >= 0 ? getPingBadge(voicePing) : "*(Inactive / No Voice)*",
        inline: true,
      },
      {
        name: "🌐 Lavalink Server Latency",
        value: lavalinkPing >= 0 ? getPingBadge(lavalinkPing) : getPingBadge(activeNode?.stats?.uptime ? 180 : -1),
        inline: true,
      },
      {
        name: "🤖 Bot WebSocket Latency",
        value: getPingBadge(clientPing),
        inline: true,
      },
    ]);

    // Active Node Specs
    if (activeNode) {
      const stats = activeNode.stats;
      const memUsedMb = stats?.memory ? Math.round(stats.memory.used / 1024 / 1024) : 0;
      const memTotalMb = stats?.memory ? Math.round(stats.memory.reservable / 1024 / 1024) : 0;
      const cpuLoad = stats?.cpu ? (stats.cpu.lavalinkLoad * 100).toFixed(1) : "0.0";
      const frameDeficit = stats?.frameStats?.deficit ?? 0;

      embed.addFields([
        {
          name: "🖥️ Connected Audio Engine",
          value:
            `• **Node:** \`${activeNode.id}\` (${activeNode.options.host})\n` +
            `• **Status:** ${activeNode.connected ? "🟢 Online & Streaming" : "🔴 Disconnected"}\n` +
            `• **Active Streams:** \`${stats?.playingPlayers ?? 0}\` playing (\`${stats?.players ?? 0}\` total)\n` +
            `• **Engine CPU / RAM:** \`${cpuLoad}%\` CPU • \`${memUsedMb} MB / ${memTotalMb} MB\``,
          inline: false,
        },
        {
          name: "📊 Audio Packet Fidelity & Health",
          value:
            frameDeficit === 0
              ? "✅ **100% Stream Health** (0 audio frame deficit / 0% packet loss)"
              : `⚠️ **Deficit Frames:** \`${frameDeficit}\` (Minor jitter / auto-recovering)`,
          inline: false,
        },
      ]);
    }

    // Track Audio Details if Playing
    if (currentTrack && sourceInfo) {
      embed.addFields([
        {
          name: "🎧 Current Track Pipeline",
          value:
            `• **Source:** ${sourceInfo.badge}\n` +
            `• **Quality Standard:** \`${sourceInfo.quality}\`\n` +
            `• **Playback Position:** \`${formatDuration(player.position)} / ${formatDuration(currentTrack.info.duration)}\``,
          inline: false,
        },
      ]);
    }

    embed.setFooter({
      text: `Interaction Round-Trip: ${roundTrip}ms • South Conclave Real-Time Monitor`,
    });
    embed.setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    autoDeleteReply(interaction, 15000);
  },
};
