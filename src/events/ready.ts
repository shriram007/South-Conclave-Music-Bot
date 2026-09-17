import { ActivityType, Client, REST, Routes } from "discord.js";
import { config } from "../config.js";
import { commands } from "../commands/index.js";
import { lavalink } from "../lavalink/client.js";
import { loadPrefixes } from "../utils/prefixes.js";
import { load247, rejoin247Channels } from "../utils/twentyFourSeven.js";

export async function onReady(client: Client) {
  if (!client.user) return;
  console.log(`[Bot] Logged in as ${client.user.tag} (ID: ${client.user.id})`);

  // Load server prefixes and 24/7 configurations
  loadPrefixes();
  load247();

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

  // Initialize Lavalink node connection
  await lavalink.init({
    id: client.user.id,
    username: client.user.username,
  });

  // Automatically rejoin 24/7 voice channels once Lavalink node connects
  lavalink.nodeManager.once("connect", async () => {
    await rejoin247Channels(client);
  });

  // Register Slash Commands
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const slashCommandsData = commands.map((cmd) => cmd.data.toJSON());

  try {
    console.log(`[Commands] Deploying ${slashCommandsData.length} instant commands to ${client.guilds.cache.size} server(s)...`);

    // Register instantly to every guild the bot is currently in (0 seconds propagation)
    for (const [guildId, guild] of client.guilds.cache) {
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId || client.user.id, guildId),
        { body: slashCommandsData }
      );
      console.log(`[Commands] Instant commands active in "${guild.name}" (${guildId})`);
    }

    // Also register globally so any future servers get them automatically
    rest.put(
      Routes.applicationCommands(config.discord.clientId || client.user.id),
      { body: slashCommandsData }
    ).catch(() => {});
  } catch (error: any) {
    console.error("[Commands] Error deploying slash commands:", error);
  }
}
