import { calculateFuzzySimilarity, parseTrackTitle } from './formatters.js';

export interface TrackIdentity {
  title: string;
  author?: string;
  duration?: number;
  isStream?: boolean;
}
export function normalizeIdentity(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
}
function cleanTitleForComparison(title: string): string {
  return normalizeIdentity(
    parseTrackTitle(title).songTitle
      .replace(/\((?:feat\.?|ft\.?|featuring|with)\s+.*?\)/gi, '')
      .replace(/\[(?:feat\.?|ft\.?|featuring|with)\s+.*?\]/gi, '')
      .replace(/\b(?:feat\.?|ft\.?|featuring|with)\s+.*$/gi, '')
  );
}

export function sameTitle(a: string, b: string): boolean {
  const left = cleanTitleForComparison(a);
  const right = cleanTitleForComparison(b);
  if (!left || !right) return false;
  return left === right || (Math.min(left.length, right.length) >= 6 && calculateFuzzySimilarity(left, right) >= 0.86);
}
const variants = /\b(cover|karaoke|instrumental|remix|slowed|sped up|nightcore|lofi|lo fi|live|tribute|8d|bass boosted|jukebox|mashup|teaser|trailer|dialogue|dialogues|promo|behind the scenes)\b/gi;
export function hasUnrequestedVersion(candidate: string, requested = ''): boolean {
  const wanted = new Set(normalizeIdentity(requested).match(variants) || []);
  return (normalizeIdentity(candidate).match(variants) || []).some(tag => !wanted.has(tag));
}
export function authorConfidence(author = ''): number {
  if (/\b(unknown|various artists)\b/i.test(author) || !author.trim()) return -2;
  if (/ - Topic$|VEVO$/i.test(author)) return 3;
  if (/think music|sony music|saregama|t-series|zee music|wunderbar films|aditya music|lahari|u1 records|sun pictures|yrf/i.test(author)) return 2;
  return 0;
}
/** Conservative radio policy; channel names are hints, not verified ownership. */
export function isPreferredRadioUpload(track: TrackIdentity): boolean {
  return !track.isStream && authorConfidence(track.author) >= 2 && !hasUnrequestedVersion(track.title);
}
export function sameRecording(candidate: TrackIdentity, target: TrackIdentity): boolean {
  if (candidate.isStream || !sameTitle(candidate.title, target.title) || hasUnrequestedVersion(candidate.title, target.title)) return false;
  const a = parseTrackTitle(candidate.title, candidate.author);
  const b = parseTrackTitle(target.title, target.author);
  if (a.movieOrAlbum && b.movieOrAlbum && normalizeIdentity(a.movieOrAlbum) !== normalizeIdentity(b.movieOrAlbum)) return false;
  if (a.artist && b.artist) {
    const ca = normalizeIdentity(a.artist), ta = normalizeIdentity(b.artist);
    if (!ca.includes(ta) && !ta.includes(ca) && calculateFuzzySimilarity(ca, ta) < 0.86) return false;
  }
  if (candidate.duration && target.duration && Math.abs(candidate.duration - target.duration) > Math.max(15000, target.duration * 0.12)) return false;
  return true;
}
/** Rank only relevant results; channel reputation never overrides song identity. */
export function rankSearchTracks<T extends { info: TrackIdentity }>(tracks: T[], query: string): T[] {
  const target = parseTrackTitle(query);
  const normalizedQuery = normalizeIdentity(query);
  const targetTitle = cleanTitleForComparison(target.songTitle);
  const score = (track: T) => {
    const parsed = parseTrackTitle(track.info.title, track.info.author);
    const title = cleanTitleForComparison(parsed.songTitle);
    const metadata = normalizeIdentity(`${parsed.songTitle} ${parsed.movieOrAlbum} ${parsed.artist} ${track.info.author || ''}`);
    const tokens = normalizedQuery.split(' ').filter(Boolean);
    const coverage = tokens.filter(t => metadata.split(' ').includes(t)).length / Math.max(tokens.length, 1);
    const exact = sameTitle(track.info.title, target.songTitle);

    if (track.info.isStream || hasUnrequestedVersion(track.info.title, query)) return -Infinity;

    const titleOverlap = title.length >= 3 && (
      title.includes(targetTitle) ||
      targetTitle.includes(title) ||
      normalizedQuery.includes(title) ||
      (title.length >= 5 && targetTitle.length >= 5 && calculateFuzzySimilarity(title, targetTitle) >= 0.8)
    );

    if (!exact && (!titleOverlap || coverage < 0.6)) return -Infinity;

    if (target.artist && parsed.artist) {
      const ta = normalizeIdentity(target.artist);
      const pa = normalizeIdentity(parsed.artist);
      const taTokens = ta.split(' ').filter(t => t.length > 2);
      const paTokens = pa.split(' ').filter(t => t.length > 2);
      const hasArtistOverlap = ta.includes(pa) || pa.includes(ta) || taTokens.some(t => paTokens.includes(t));
      if (!hasArtistOverlap) return -Infinity;
    }

    return (exact ? 10 : 8) + coverage * 2 + authorConfidence(track.info.author);
  };
  return tracks.map(track => ({ track, score: score(track) })).filter(x => Number.isFinite(x.score)).sort((a, b) => b.score - a.score).map(x => x.track);
}
