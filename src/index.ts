import { ActivityType, Client, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { initLavalink, lavalink } from "./lavalink/client.js";
import { onReady } from "./events/ready.js";
import { handleInteraction } from "./events/interactionCreate.js";
import { handleVoiceStateUpdate } from "./events/voiceStateUpdate.js";

// Validate mandatory Discord token
if (!config.discord.token) {
  console.error("❌ ERROR: DISCORD_TOKEN is missing in your .env file!");
  console.error("Please create a .env file based on .env.example and provide your Discord Bot Token.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
  presence: {
    status: "online",
    activities: [
      {
        name: "South Conclave Hi-Fi | /play",
        type: ActivityType.Listening,
      },
    ],
  },
});

// Initialize Lavalink Manager
initLavalink(client);

// Forward raw voice packets to Lavalink (required for audio handshake)
client.on("raw", (d) => {
  lavalink.sendRawData(d);
});

// Gateway Lifecycle & Auto-Reconnect Handlers
client.on("shardDisconnect", (event, shardId) => {
  console.warn(`[Gateway] Shard ${shardId} disconnected:`, event?.reason || event);
});
client.on("shardReconnecting", (shardId) => {
  console.log(`[Gateway] Shard ${shardId} reconnecting...`);
});
client.on("shardResume", (shardId, replayedEvents) => {
  console.log(`[Gateway] Shard ${shardId} resumed (${replayedEvents} events replayed).`);
});
client.on("error", (error) => {
  console.error("[Discord Client Error]:", error);
});

// Bot Lifecycle Events
client.once(Events.ClientReady, () => onReady(client));
client.on("guildCreate", async (guild) => {
  console.log(`🎉 Joined new server: "${guild.name}" (ID: ${guild.id})`);
  try {
    const { commands } = await import("./commands/index.js");
    const { REST, Routes } = await import("discord.js");
    const rest = new REST({ version: "10" }).setToken(config.discord.token);
    const slashCommandsData = commands.map((cmd) => cmd.data.toJSON());
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId || client.user!.id, guild.id),
      { body: slashCommandsData }
    );
    console.log(`[Commands] Instant commands deployed to new server "${guild.name}"!`);
  } catch (err) {
    console.error(`[Commands] Failed to deploy commands to new server "${guild.name}":`, err);
  }
});
client.on("interactionCreate", (interaction) => handleInteraction(interaction));
client.on("voiceStateUpdate", (oldState, newState) => handleVoiceStateUpdate(oldState, newState, client));

// Anti-Crash & Auto-Recovery Handlers
process.on("unhandledRejection", (reason: any) => {
  console.error("[Anti-Crash] Unhandled Rejection (Prevented Crash):", reason?.message || reason);
});

process.on("uncaughtException", (error: Error) => {
  console.error("[Anti-Crash] Uncaught Exception (Prevented Crash):", error.message);
});

// Handle process termination cleanly
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Shutting down bot gracefully...");
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Shutdown] Terminating process...");
  client.destroy();
  process.exit(0);
});

// Connect to Discord Gateway
client.login(config.discord.token).catch((err) => {
  console.error("❌ Failed to login to Discord Gateway:", err);
});
