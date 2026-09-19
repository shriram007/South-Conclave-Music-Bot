import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrackTitle, getSourceInfo } from '../dist/utils/formatters.js';
import { sameTitle, sameRecording, rankSearchTracks } from '../dist/utils/trackSelection.js';
import { isFuzzyTitleMatch, parseJioSaavnSong } from '../dist/services/jiosaavn.js';
import { applyLoudnessNormalization } from '../dist/commands/normalize.js';
import CryptoJS from 'crypto-js';

const track = (title, author, duration = 240000) => ({ info: { title, author, duration } });

test('Indian pipe title keeps Anthaathi, album, and composer', () => {
  const p = parseTrackTitle('96 Songs | Anthaathi Video Song | Vijay Sethupathi, Trisha | Govind Vasantha', 'Think Music India');
  assert.equal(p.songTitle, 'Anthaathi');
  assert.equal(p.movieOrAlbum, '96');
  assert.equal(p.artist, 'Govind Vasantha');
});
test('VadaChennai title removes label author and keeps song', () => {
  const p = parseTrackTitle('VADACHENNAI - Kaarkuzhal Kadavaiye (Lyric Video) | Dhanush | Vetri Maaran | Santhosh Narayanan', 'Wunderbar Films');
  assert.equal(p.songTitle, 'Kaarkuzhal Kadavaiye');
  assert.equal(p.movieOrAlbum, 'VADACHENNAI');
  assert.equal(p.artist, '');
});
test('artist query and suffix cleanup preserve identity', () => {
  assert.equal(parseTrackTitle('Govind Vasantha - Anthaathi').artist, 'Govind Vasantha');
  assert.equal(parseTrackTitle('Anthaathi - Official Audio').songTitle, 'Anthaathi');
  assert.equal(parseTrackTitle('Love Song').songTitle, 'Love Song');
  assert.equal(parseTrackTitle('Kaarkuzhal Kadavaiye (From"VadaChennai")').songTitle, 'Kaarkuzhal Kadavaiye');
});
test('different album tracks, reversed letters and short substrings cannot match', () => {
  for (const [a, b] of [['The Life of Ram', 'Anthaathi'], ['Silent', 'Listen'], ['Love', 'Love Story'], ['', '']]) {
    assert.equal(isFuzzyTitleMatch(a, b), false, `${a} vs ${b}`);
  }
  assert.equal(sameTitle('Anthaathi (From "96")', 'Anthaathi'), true);
  assert.equal(sameTitle('கண்ணம்மா', 'கண்ணம்மா'), true);
  assert.equal(sameTitle('கண்ணம்மா', 'அந்தாதி'), false);
});
test('original artist ranks above reuploads and covers', () => {
  const unofficial = track('Anthaathi', 'Random uploader');
  const official = track('Anthaathi', 'Govind Vasantha - Topic');
  const cover = track('Anthaathi (Cover)', 'Govind Vasantha - Topic');
  assert.deepEqual(rankSearchTracks([unofficial, cover, official, track('The Life of Ram', 'Govind Vasantha')], 'Anthaathi'), [official, unofficial]);
  assert.deepEqual(rankSearchTracks([unofficial, official], 'Govind Vasantha - Anthaathi'), [official]);
  assert.deepEqual(rankSearchTracks([track('The Life of Ram', 'Govind Vasantha')], 'Govind Vasantha - Anthaathi'), []);
});
test('replacement checks artist, version and duration', () => {
  const seed = track('Anthaathi', 'Govind Vasantha').info;
  assert.equal(sameRecording(track('Anthaathi', 'Other Singer').info, seed), false);
  assert.equal(sameRecording(track('Anthaathi (Slowed)', 'Govind Vasantha').info, seed), false);
  assert.equal(sameRecording(track('Anthaathi', 'Govind Vasantha', 400000).info, seed), false);
  assert.equal(sameRecording(track('Anthaathi (From "96")', 'Govind Vasantha - Topic').info, seed), true);
});
test('JioSaavn requests 320 only when catalog says available; unknown language stays unknown', () => {
  const key = CryptoJS.enc.Utf8.parse('38346591');
  const encrypted_media_url = CryptoJS.DES.encrypt('https://example.com/song_160.mp4', key, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
  const item = { id: 'test', title: 'Anthaathi', encrypted_media_url };
  assert.equal(parseJioSaavnSong(item).streamUrl, 'https://example.com/song_160.mp4');
  assert.equal(parseJioSaavnSong(item).language, 'global');
  assert.equal(parseJioSaavnSong({ ...item, more_info: { '320kbps': true } }).streamUrl, 'https://example.com/song_320.mp4');
});
test('quality display does not invent source bitrate', () => {
  for (const source of ['youtube', 'youtubemusic', 'spotify', 'applemusic', 'deezer']) {
    assert.equal(getSourceInfo(source).quality, 'Source bitrate not reported');
  }
});
test('unsupported normalization does not silently lower volume', async () => {
  const data = new Map();
  const player = { node: { info: { filters: [] } }, setData: (k,v) => data.set(k,v), filterManager: { data: { volume: 1 } } };
  assert.equal(await applyLoudnessNormalization(player, true), false);
  assert.equal(player.filterManager.data.volume, 1);
  assert.equal(data.get('normalized'), false);
});
test('normalization disables its own filter while preserving EQ', async () => {
  let calls = 0;
  const player = { node: { info: { filters: ['normalization'] } }, setData() {}, filterManager: {
    equalizerBands: [{band: 1, gain: -0.05}], filters: { lavalinkLavaDspxPlugin: { normalization: true } },
    lavalinkLavaDspxPlugin: { async toggleNormalization() { calls++; } }
  } };
  assert.equal(await applyLoudnessNormalization(player, false), true);
  assert.equal(calls, 1);
  assert.equal(player.filterManager.equalizerBands.length, 1);
});

test('autoplay discards a pending recommendation after disabling, replacing seed, or purging', async (t) => {
  const { initLavalink, prefetchAutoplayTrack, purgeAutoplayTracks } = await import('../dist/lavalink/client.js');
  const intervalMock = t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  const manager = initLavalink({ guilds: { cache: new Map() }, channels: { cache: new Map() } });
  intervalMock.mock.restore();
  manager.nodeManager.nodes.clear();
  for (const action of ['disable', 'replace', 'purge', 'destroy', 'queue']) {
    let release;
    const deferred = new Promise(resolve => { release = resolve; });
    const seed = { ...track('Anthaathi', 'Think Music India'), requester: {}, userData: {} };
    seed.info.identifier = '29WzIwFvVdg';
    const next = { ...track('High on Love', 'Sid Sriram - Topic'), requester: {}, userData: {} };
    next.info.identifier = 'nextSong123';
    const node = { id: 'test', connected: true, search: async () => { await deferred; return { tracks: [next] }; } };
    manager.nodeManager.nodes.set('test', node);
    const data = new Map();
    const player = { guildId: 'test', node, getData: k => data.get(k), setData: (k,v) => data.set(k,v), queue: {
      current: seed, previous: [], tracks: [], async add(track) { this.tracks.push(track); }
    } };
    manager.players.set('test', player);
    const pending = prefetchAutoplayTrack(player);
    if (action === 'disable') data.set('autoplay', false);
    if (action === 'replace') player.queue.current = next;
    if (action === 'purge') purgeAutoplayTracks(player);
    if (action === 'destroy') manager.players.delete('test');
    if (action === 'queue') player.queue.tracks.push(seed);
    release();
    await pending;
    assert.equal(player.queue.tracks.length, action === 'queue' ? 1 : 0, action);
    assert.equal(data.get('prefetching_autoplay'), false);
  }
});

test('smart search keeps YTM priority and chooses original artist without migrating active audio', async () => {
  const { lavalink } = await import('../dist/lavalink/client.js');
  const { smartSearch } = await import('../dist/commands/play.js');
  lavalink.nodeManager.nodes.clear();
  let migrations = 0;
  const official = track('Anthaathi', 'Govind Vasantha - Topic');
  official.info.identifier = 'official';
  const calls = [];
  const node = { id: 'Primary-CustomNode', connected: true, async search(opts) {
    calls.push(opts.source);
    return { loadType: 'search', tracks: [track('Anthaathi Cover', 'Fan'), track('The Life of Ram', 'Govind Vasantha'), official] };
  } };
  lavalink.nodeManager.nodes.set(node.id, node);
  const player = { node: { id: 'current', connected: true, search: node.search }, playing: true, changeNode: async () => { migrations++; } };
  // Current node is healthy and may resolve the same catalog.
  player.node.search = node.search;
  const result = await smartSearch(player, 'Govind Vasantha - Anthaathi', false, {});
  assert.equal(result.tracks[0], official);
  assert.deepEqual(calls, ['ytmsearch']);
  assert.equal(migrations, 0);
});

test('stalled-track event leaves queue advancement to lavalink-client', async () => {
  const { lavalink } = await import('../dist/lavalink/client.js');
  let skipped = 0;
  const player = { node: { id: 'stalled-test' }, skip: async () => { skipped++; } };
  await lavalink.listeners('trackStuck')[0](player, track('Anthaathi', 'Govind Vasantha'), { thresholdMs: 10000 });
  assert.equal(skipped, 0);
});
