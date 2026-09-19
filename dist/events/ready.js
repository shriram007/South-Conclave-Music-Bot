import { ActivityType, REST, Routes } from "discord.js";
import { config } from "../config.js";
import { commands } from "../commands/index.js";
import { lavalink } from "../lavalink/client.js";
import { loadPrefixes } from "../utils/prefixes.js";
import { load247, rejoin247Channels } from "../utils/twentyFourSeven.js";
import { loadFavorites } from "../utils/favorites.js";
import { loadPlaylists } from "../utils/playlists.js";
import { restoreSessions, startSessionAutoSave } from "../utils/sessionRecovery.js";
export async function onReady(client) {
    if (!client.user)
        return;
    console.log(`[Bot] Logged in as ${client.user.tag} (ID: ${client.user.id})`);
    // Load server prefixes, 24/7 configurations, personal favorites, and custom playlists
    loadPrefixes();
    load247();
    loadFavorites();
    loadPlaylists();
    // Set rich bot activity
    client.user.setPresence({
        activities: [
            {
                name: "South Conclave Hi-Fi | /play",
                type: ActivityType.Listening,
            },
        ],
        status: "online",
    });
    const guildNames = client.guilds.cache.map((g) => `"${g.name}" (${g.id})`).join(", ");
    console.log(`[Bot] Currently in ${client.guilds.cache.size} server(s): ${guildNames || "⚠️ NONE! (You need to invite the bot to your server)"}`);
    // Register before init so a fast node connection cannot miss restoration.
    lavalink.nodeManager.once("connect", async () => {
        try {
            await restoreSessions(client);
            await rejoin247Channels(client);
        }
        finally {
            startSessionAutoSave();
        }
    });
    await lavalink.init({ id: client.user.id, username: client.user.username });
    // Register Slash Commands
    const rest = new REST({ version: "10" }).setToken(config.discord.token);
    const slashCommandsData = commands.map((cmd) => cmd.data.toJSON());
    try {
        console.log(`[Commands] Deploying ${slashCommandsData.length} instant commands to ${client.guilds.cache.size} server(s)...`);
        // Register instantly to every guild the bot is currently in (0 seconds propagation)
        for (const [guildId, guild] of client.guilds.cache) {
            await rest.put(Routes.applicationGuildCommands(config.discord.clientId || client.user.id, guildId), { body: slashCommandsData });
            console.log(`[Commands] Instant commands active in "${guild.name}" (${guildId})`);
        }
        // Also register globally so any future servers get them automatically
        rest.put(Routes.applicationCommands(config.discord.clientId || client.user.id), { body: slashCommandsData }).catch(() => { });
    }
    catch (error) {
        console.error("[Commands] Error deploying slash commands:", error);
    }
}
