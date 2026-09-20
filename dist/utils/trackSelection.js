import { calculateFuzzySimilarity, parseTrackTitle } from './formatters.js';
export function normalizeIdentity(value) {
    return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}
export function sameTitle(a, b) {
    const left = normalizeIdentity(parseTrackTitle(a).songTitle);
    const right = normalizeIdentity(parseTrackTitle(b).songTitle);
    if (!left || !right)
        return false;
    return left === right || (Math.min(left.length, right.length) >= 6 && calculateFuzzySimilarity(left, right) >= 0.86);
}
const variants = /\b(cover|karaoke|instrumental|remix|slowed|sped up|nightcore|lofi|lo fi|live|tribute|8d|bass boosted|jukebox|mashup)\b/gi;
export function hasUnrequestedVersion(candidate, requested = '') {
    const wanted = new Set(normalizeIdentity(requested).match(variants) || []);
    return (normalizeIdentity(candidate).match(variants) || []).some(tag => !wanted.has(tag));
}
export function authorConfidence(author = '') {
    if (/\b(unknown|various artists)\b/i.test(author) || !author.trim())
        return -2;
    if (/ - Topic$|VEVO$/i.test(author))
        return 3;
    if (/think music|sony music|saregama|t-series|zee music|wunderbar films|aditya music|lahari|u1 records|sun pictures|yrf/i.test(author))
        return 2;
    return 0;
}
/** Conservative radio policy; channel names are hints, not verified ownership. */
export function isPreferredRadioUpload(track) {
    return !track.isStream && authorConfidence(track.author) >= 2 && !hasUnrequestedVersion(track.title);
}
export function sameRecording(candidate, target) {
    if (candidate.isStream || !sameTitle(candidate.title, target.title) || hasUnrequestedVersion(candidate.title, target.title))
        return false;
    const a = parseTrackTitle(candidate.title, candidate.author);
    const b = parseTrackTitle(target.title, target.author);
    if (a.movieOrAlbum && b.movieOrAlbum && normalizeIdentity(a.movieOrAlbum) !== normalizeIdentity(b.movieOrAlbum))
        return false;
    if (a.artist && b.artist) {
        const ca = normalizeIdentity(a.artist), ta = normalizeIdentity(b.artist);
        if (!ca.includes(ta) && !ta.includes(ca) && calculateFuzzySimilarity(ca, ta) < 0.86)
            return false;
    }
    if (candidate.duration && target.duration && Math.abs(candidate.duration - target.duration) > Math.max(15000, target.duration * 0.12))
        return false;
    return true;
}
/** Rank only relevant results; channel reputation never overrides song identity. */
export function rankSearchTracks(tracks, query) {
    const target = parseTrackTitle(query);
    const normalizedQuery = normalizeIdentity(query);
    const score = (track) => {
        const parsed = parseTrackTitle(track.info.title, track.info.author);
        const title = normalizeIdentity(parsed.songTitle);
        const metadata = normalizeIdentity(`${parsed.songTitle} ${parsed.movieOrAlbum} ${parsed.artist}`);
        const tokens = normalizedQuery.split(' ').filter(Boolean);
        const coverage = tokens.filter(t => metadata.split(' ').includes(t)).length / Math.max(tokens.length, 1);
        const exact = sameTitle(track.info.title, target.songTitle);
        if (track.info.isStream || hasUnrequestedVersion(track.info.title, query) || (!exact && (title.length < 3 || !normalizedQuery.includes(title) || coverage < 0.8)))
            return -Infinity;
        if (target.artist && parsed.artist && !normalizeIdentity(parsed.artist).includes(normalizeIdentity(target.artist)))
            return -Infinity;
        return (exact ? 10 : 8) + coverage + authorConfidence(track.info.author);
    };
    return tracks.map(track => ({ track, score: score(track) })).filter(x => Number.isFinite(x.score)).sort((a, b) => b.score - a.score).map(x => x.track);
}
