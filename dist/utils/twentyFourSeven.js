import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lavalink } from "../lavalink/client.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const SETTINGS_FILE = path.join(DATA_DIR, "twentyFourSeven.json");
const configCache = new Map();
function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(SETTINGS_FILE)) {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify({}), "utf-8");
    }
}
export function load247() {
    try {
        ensureFile();
        const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
        const json = JSON.parse(data || "{}");
        for (const [guildId, cfg] of Object.entries(json)) {
            if (cfg && typeof cfg === "object") {
                configCache.set(guildId, cfg);
            }
        }
        console.log(`[24/7] Loaded 24/7 settings for ${configCache.size} server(s).`);
    }
    catch (err) {
        console.error("[24/7] Failed to load 24/7 settings:", err);
    }
}
export function is247Enabled(guildId) {
    return configCache.get(guildId)?.enabled ?? false;
}
export function get247Config(guildId) {
    return configCache.get(guildId);
}
export function set247(guildId, enabled, voiceChannelId, textChannelId) {
    if (enabled && voiceChannelId) {
        configCache.set(guildId, { enabled: true, voiceChannelId, textChannelId });
    }
    else {
        configCache.delete(guildId);
    }
    try {
        ensureFile();
        const obj = {};
        for (const [gId, val] of configCache.entries()) {
            obj[gId] = val;
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), "utf-8");
        console.log(`[24/7] Saved 24/7 state for guild ${guildId}: ${enabled}`);
    }
    catch (err) {
        console.error("[24/7] Failed to save 24/7 settings:", err);
    }
}
/**
 * On bot startup, automatically reconnects to all 24/7 voice channels!
 */
export async function rejoin247Channels(client) {
    for (const [guildId, cfg] of configCache.entries()) {
        if (!cfg.enabled || !cfg.voiceChannelId)
            continue;
        const guild = client.guilds.cache.get(guildId);
        if (!guild)
            continue;
        const channel = guild.channels.cache.get(cfg.voiceChannelId);
        if (!channel || !channel.isVoiceBased())
            continue;
        try {
            let player = lavalink.getPlayer(guildId);
            if (!player) {
                player = lavalink.createPlayer({
                    guildId,
                    voiceChannelId: channel.id,
                    textChannelId: cfg.textChannelId,
                    selfDeaf: true,
                    selfMute: false,
                    volume: 100,
                });
            }
            if (!player.connected) {
                await player.connect();
                console.log(`[24/7] Reconnected to 24/7 voice channel "${channel.name}" in "${guild.name}"`);
            }
        }
        catch (err) {
            console.error(`[24/7] Failed to reconnect to channel in guild ${guildId}:`, err);
        }
    }
}
