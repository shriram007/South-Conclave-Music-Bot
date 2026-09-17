import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "../../data");
const FAVORITES_FILE = path.join(DATA_DIR, "favorites.json");
// userId -> FavoriteTrack[]
const favoritesCache = new Map();
function ensureFile() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FAVORITES_FILE)) {
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify({}), "utf-8");
    }
}
export function loadFavorites() {
    try {
        ensureFile();
        const data = fs.readFileSync(FAVORITES_FILE, "utf-8");
        const json = JSON.parse(data || "{}");
        for (const [userId, tracks] of Object.entries(json)) {
            if (Array.isArray(tracks)) {
                favoritesCache.set(userId, tracks);
            }
        }
        console.log(`[Favorites] Loaded personal favorites for ${favoritesCache.size} user(s).`);
    }
    catch (err) {
        console.error("[Favorites] Failed to load favorites:", err);
    }
}
function saveFavorites() {
    try {
        ensureFile();
        const obj = {};
        for (const [userId, tracks] of favoritesCache.entries()) {
            obj[userId] = tracks;
        }
        fs.writeFileSync(FAVORITES_FILE, JSON.stringify(obj, null, 2), "utf-8");
    }
    catch (err) {
        console.error("[Favorites] Failed to save favorites:", err);
    }
}
export function getFavorites(userId) {
    return favoritesCache.get(userId) || [];
}
export function isFavorite(userId, uri) {
    if (!uri)
        return false;
    const list = favoritesCache.get(userId) || [];
    return list.some((t) => t.uri === uri);
}
export function toggleFavorite(userId, track) {
    let list = favoritesCache.get(userId) || [];
    const existingIdx = list.findIndex((t) => t.uri === track.uri);
    if (existingIdx !== -1) {
        // Remove if already liked (toggle off)
        list.splice(existingIdx, 1);
        favoritesCache.set(userId, list);
        saveFavorites();
        return { added: false, total: list.length };
    }
    else {
        // Add to favorites (max 150 tracks per user)
        const item = {
            title: track.title,
            uri: track.uri,
            author: track.author,
            duration: track.duration,
            artworkUrl: track.artworkUrl,
            addedAt: Date.now(),
        };
        list.unshift(item);
        if (list.length > 150)
            list.pop();
        favoritesCache.set(userId, list);
        saveFavorites();
        return { added: true, total: list.length };
    }
}
export function clearFavorites(userId) {
    favoritesCache.delete(userId);
    saveFavorites();
}
