import { createHash } from 'node:crypto';
/** A video URL always means that one video, even when it includes a playlist. */
export function youtubeVideoId(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        let id = null;
        if (host === 'youtu.be')
            id = url.pathname.split('/')[1];
        else if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
            id = url.searchParams.get('v');
            if (!id && /^\/(shorts|embed|live)\//.test(url.pathname))
                id = url.pathname.split('/')[2];
        }
        return id && /^[\w-]{11}$/.test(id) ? id : null;
    }
    catch {
        return null;
    }
}
export function seekToken(player) {
    return createHash('sha256').update(`${player.queue.current?.encoded || player.queue.current?.info?.identifier || ''}:${player.getData('track_epoch') || 0}`).digest('hex').slice(0, 16);
}
export function canSeek(track) {
    return !!track && !track.info.isStream && track.info.isSeekable === true && Number.isFinite(track.info.duration) && track.info.duration > 1000;
}
/** Strict absolute/relative timestamp parser; invalid inputs never become zero. */
export function parseSeek(value, position, duration) {
    const match = value.trim().match(/^([+-]?)(\d+(?::\d{1,2}){0,2})(?:s)?$/i);
    if (!match || !Number.isFinite(duration) || duration <= 1000)
        return null;
    const parts = match[2].split(':').map(Number);
    if (parts.slice(1).some(v => v >= 60))
        return null;
    const seconds = parts.reduce((sum, v) => sum * 60 + v, 0);
    const offset = seconds * 1000;
    if (!Number.isSafeInteger(offset))
        return null;
    const target = match[1] ? position + (match[1] === '-' ? -offset : offset) : offset;
    return Math.min(Math.max(0, target), duration - 1000);
}
export async function withTimeout(work, ms) {
    let timer;
    try {
        return await Promise.race([work, new Promise(r => { timer = setTimeout(() => r(null), ms); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Never reuse queued metadata for a different encoded audio track. */
export function confirmedTrack(manager, queued, payload) {
    if (!payload?.track?.encoded)
        return queued;
    if (queued?.encoded === payload.track.encoded)
        return queued;
    return manager.utils.buildTrack(payload.track, payload.track.userData?.requester);
}
/** A temporary provider failure should not blacklist a recording until restart. */
export class RecentFailures {
    ttlMs;
    now;
    entries = new Map();
    constructor(ttlMs = 180000, now = () => Date.now()) {
        this.ttlMs = ttlMs;
        this.now = now;
    }
    add(id) {
        if (this.entries.size >= 500)
            this.entries.delete(this.entries.keys().next().value);
        this.entries.set(id, this.now() + this.ttlMs);
    }
    has(id) {
        const expiry = this.entries.get(id);
        if (expiry === undefined)
            return false;
        if (expiry <= this.now()) {
            this.entries.delete(id);
            return false;
        }
        return true;
    }
    delete(id) { this.entries.delete(id); }
}
