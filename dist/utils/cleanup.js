/**
 * Automatically deletes an interaction reply after a set delay (default: 6 seconds)
 * Keeps the music channel pristine and free of command clutter
 */
export function autoDeleteReply(interaction, delayMs = 8000) {
    setTimeout(async () => {
        try {
            if (interaction?.ephemeral)
                return;
            if (typeof interaction?.deleteReply === "function") {
                await interaction.deleteReply().catch(() => { });
            }
        }
        catch { }
    }, delayMs);
}
/**
 * Automatically deletes a standard Discord channel message after a set delay (default: 6 seconds)
 */
export function autoDeleteMessage(message, delayMs = 6000) {
    setTimeout(async () => {
        try {
            if (message && typeof message.delete === "function") {
                await message.delete().catch(() => { });
            }
        }
        catch { }
    }, delayMs);
}
