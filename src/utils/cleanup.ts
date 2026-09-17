import { ChatInputCommandInteraction, Message } from "discord.js";

/**
 * Automatically deletes an interaction reply after a set delay (default: 6 seconds)
 * Keeps the music channel pristine and free of command clutter
 */
export function autoDeleteReply(
  interaction: ChatInputCommandInteraction,
  delayMs: number = 6000
): void {
  setTimeout(async () => {
    try {
      await interaction.deleteReply().catch(() => {});
    } catch {}
  }, delayMs);
}

/**
 * Automatically deletes a standard Discord channel message after a set delay (default: 6 seconds)
 */
export function autoDeleteMessage(
  message: Message,
  delayMs: number = 6000
): void {
  setTimeout(async () => {
    try {
      if (message && typeof message.delete === "function") {
        await message.delete().catch(() => {});
      }
    } catch {}
  }, delayMs);
}
