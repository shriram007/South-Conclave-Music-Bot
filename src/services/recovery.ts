import { withTimeout } from '../utils/playback.js';
import { authorConfidence, rankSearchTracks, sameRecording } from '../utils/trackSelection.js';
import { parseTrackTitle } from '../utils/formatters.js';
import { loadJioSaavnAsLavalinkTrack, resolveJioSaavnTrack, resolveJioSaavnUrl } from './jiosaavn.js';

/** Bounded recovery. Explicit video links can only recover the same video. */
export async function resolveRecoveryTrack(original: any, candidateNodes: any[], isCurrent: () => boolean): Promise<{ track: any; node: any } | null> {
  const deadline = Date.now() + 14000;
  const nodes = candidateNodes.filter((n, i, all) => n?.connected && all.findIndex(x => x?.id === n.id) === i).slice(0, 3);
  const active = () => isCurrent() && Date.now() < deadline;
  const search = async (node: any, query: string, source?: string): Promise<any[]> => {
    if (!active()) return [];
    try {
      const result: any = await withTimeout(node.search({ query, ...(source ? { source } : {}) }, original.requester), Math.min(3000, deadline - Date.now()));
      return active() && Array.isArray(result?.tracks) ? result.tracks : [];
    } catch { return []; }
  };
  const exactId = original.userData?.requestedVideoId;
  const directUri = exactId ? `https://www.youtube.com/watch?v=${exactId}` : original.userData?.streamUri || original.info.uri;
  if (directUri) {
    const results = await Promise.all(nodes.map(async node => {
      const tracks = await search(node, directUri);
      const track = tracks.find(t => exactId
        ? t.info.identifier === exactId && /youtube/i.test(t.info.sourceName)
        : original.userData?.isJioSaavn
          ? t.info.identifier === directUri || t.info.uri === directUri
          : t.info.identifier === original.info.identifier && sameRecording(t.info, original.info));
      if (!track) return null;
      // HTTP tracks have no catalog metadata. Preserve it only for the exact CDN URL.
      if (original.userData?.isJioSaavn) {
        track.info = { ...track.info, title: original.info.title, author: original.info.author, artworkUrl: original.info.artworkUrl, uri: original.info.uri };
        track.userData = { ...original.userData };
      }
      return { track, node };
    }));
    const matched = results.find(Boolean);
    if (active() && matched) return matched;
  }
  if (exactId || !active()) return null;
  const parsed = parseTrackTitle(original.info.title, original.info.author);
  if (!original.userData?.isJioSaavn) {
    const results = await Promise.all(nodes.map(async node => {
      const tracks = await search(node, parsed.fullSearchQuery, 'ytmsearch');
      const track = rankSearchTracks<any>(tracks, parsed.songTitle).find(t => sameRecording(t.info, original.info));
      if (track) track.userData = { ...track.userData, searchSource: 'ytmsearch' };
      return track ? { track, node } : null;
    }));
    const matched = results.find(Boolean);
    if (active() && matched) return matched;
  }
  if (!active()) return null;
  const jio = original.userData?.isJioSaavn
    ? await withTimeout(resolveJioSaavnUrl(original.info.uri), Math.min(4000, deadline - Date.now())).then(r => r?.type === 'track' ? r.track : null)
    : await withTimeout(resolveJioSaavnTrack(original.info.title, original.info.author), Math.min(4000, deadline - Date.now()));
  if (active() && jio && sameRecording({ title: jio.title, author: jio.artist, duration: jio.duration * 1000 }, original.info)) {
    const loaded = await withTimeout(loadJioSaavnAsLavalinkTrack(jio, original.requester, nodes), Math.min(3000, deadline - Date.now()));
    if (active() && loaded) return loaded;
  }
  if (!active() || original.userData?.isJioSaavn) return null;
  // Last resort: a recognized original upload, never an arbitrary SoundCloud cover.
  const results = await Promise.all(nodes.map(async node => {
    const tracks = await search(node, parsed.fullSearchQuery, 'ytsearch');
    const track = rankSearchTracks<any>(tracks, parsed.songTitle).find(t => authorConfidence(t.info.author) >= 2 && sameRecording(t.info, original.info));
    return track ? { track, node } : null;
  }));
  return active() ? results.find(Boolean) || null : null;
}
