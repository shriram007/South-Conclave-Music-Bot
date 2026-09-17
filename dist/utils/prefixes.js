import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const PREFIXES_FILE = path.join(DATA_DIR, "prefixes.json");
// Default prefix across all servers
export const DEFAULT_PREFIX = "!";
// In-memory cache for ultra-fast lookup: guildId -> prefix
const prefixCache = new Map();
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PREFIXES_FILE)) {
        fs.writeFileSync(PREFIXES_FILE, JSON.stringify({}), "utf-8");
    }
}
// Load persisted prefixes on startup
export function loadPrefixes() {
    try {
        ensureDataDir();
        const data = fs.readFileSync(PREFIXES_FILE, "utf-8");
        const json = JSON.parse(data || "{}");
        for (const [guildId, prefix] of Object.entries(json)) {
            if (typeof prefix === "string") {
                prefixCache.set(guildId, prefix);
            }
        }
        console.log(`[Prefixes] Loaded ${prefixCache.size} custom server prefix(es).`);
    }
    catch (err) {
        console.error("[Prefixes] Failed to load prefixes:", err);
    }
}
export function getPrefix(guildId) {
    if (!guildId)
        return DEFAULT_PREFIX;
    return prefixCache.get(guildId) || DEFAULT_PREFIX;
}
export function setPrefix(guildId, newPrefix) {
    prefixCache.set(guildId, newPrefix);
    try {
        ensureDataDir();
        const current = {};
        for (const [gId, pfx] of prefixCache.entries()) {
            current[gId] = pfx;
        }
        fs.writeFileSync(PREFIXES_FILE, JSON.stringify(current, null, 2), "utf-8");
        console.log(`[Prefixes] Updated prefix for server ${guildId} to: "${newPrefix}"`);
    }
    catch (err) {
        console.error("[Prefixes] Failed to save prefix:", err);
    }
}
