import { Client, TextChannel, VoiceBasedChannel, VoiceState } from "discord.js";
import { lavalink } from "../lavalink/client.js";
import { is247Enabled } from "../utils/twentyFourSeven.js";

// Map to track auto-disconnect timers for empty channels: guildId -> NodeJS.Timeout
const emptyChannelTimers = new Map<string, NodeJS.Timeout>();

/**
 * Handles voice state changes to auto-disconnect when empty,
 * and clean up filters when the bot leaves or is kicked.
 */
export function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  client: Client
): void {
  const guild = oldState.guild || newState.guild;
  if (!guild) return;

  const player = lavalink.getPlayer(guild.id);
  if (!player) return;

  // 1. The bot itself was disconnected or kicked from the voice channel
  if (oldState.member?.id === client.user?.id && !newState.channelId) {
    console.log(`[VoiceState] Bot disconnected from voice in "${guild.name}". Resetting equalizer to Normal (Flat).`);
    if (emptyChannelTimers.has(guild.id)) {
      clearTimeout(emptyChannelTimers.get(guild.id));
      emptyChannelTimers.delete(guild.id);
    }
    player.filterManager.resetFilters().catch(() => {});
    player.setData("hifi_active", false);
    player.setData("eq_preset", "Normal (Flat)");
    player.destroy("Bot disconnected from voice").catch(() => {});
    return;
  }

  // 2. Check if the voice channel where the bot is connected is now empty
  if (!player.voiceChannelId) return;

  // If 24/7 mode is enabled on this server, do not auto-disconnect
  if (is247Enabled(guild.id)) {
    return;
  }

  const botVoiceChannel = guild.channels.cache.get(player.voiceChannelId) as VoiceBasedChannel | undefined;
  if (!botVoiceChannel || !botVoiceChannel.isVoiceBased()) return;

  // Count active human members in the channel (excluding bots)
  const humanMembers = botVoiceChannel.members.filter((m) => !m.user.bot);

  if (humanMembers.size === 0) {
    // If a timer is already running for this guild, don't start a duplicate
    if (emptyChannelTimers.has(guild.id)) return;

    console.log(
      `[VoiceState] Everyone left voice channel "${botVoiceChannel.name}" in "${guild.name}". Disconnecting in 20s if no one rejoins...`
    );

    const timer = setTimeout(async () => {
      emptyChannelTimers.delete(guild.id);

      // Re-verify player and voice channel state after grace period
      const activePlayer = lavalink.getPlayer(guild.id);
      if (!activePlayer || !activePlayer.voiceChannelId) return;

      const currentChan = guild.channels.cache.get(activePlayer.voiceChannelId) as VoiceBasedChannel | undefined;
      const currentHumans = currentChan?.members.filter((m) => !m.user.bot);

      if (!currentHumans || currentHumans.size === 0) {
        console.log(`[VoiceState] Disconnecting bot from "${botVoiceChannel.name}" because everyone left.`);

        // Notify text channel
        if (activePlayer.textChannelId) {
          const textChannel = guild.channels.cache.get(activePlayer.textChannelId) as TextChannel | undefined;
          if (textChannel) {
            textChannel
              .send(
                `👋 Left **${botVoiceChannel.name}** because everyone left the voice channel.\n*Equalizer reset to **Normal (Flat)**.*`
              )
              .catch(() => {});
          }
        }

        // Reset EQ & destroy player cleanly
        await activePlayer.filterManager.resetFilters().catch(() => {});
        activePlayer.setData("hifi_active", false);
        activePlayer.setData("eq_preset", "Normal (Flat)");
        await activePlayer.destroy("Everyone left voice channel").catch(() => {});
      }
    }, 20_000); // 20-second grace period

    emptyChannelTimers.set(guild.id, timer);
  } else {
    // Humans are present in the channel: cancel any pending disconnect timer
    if (emptyChannelTimers.has(guild.id)) {
      console.log(
        `[VoiceState] Member active in voice channel "${botVoiceChannel.name}". Cancelled empty channel disconnect timer.`
      );
      clearTimeout(emptyChannelTimers.get(guild.id));
      emptyChannelTimers.delete(guild.id);
    }
  }
}
