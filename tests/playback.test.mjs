import test from 'node:test';
import assert from 'node:assert/strict';
import { youtubeVideoId, parseSeek, seekToken, canSeek, confirmedTrack } from '../dist/utils/playback.js';
import { rankJioSaavnRecommendations, loadJioSaavnAsLavalinkTrack, findJioSaavnAutoplay } from '../dist/services/jiosaavn.js';
import { buildPlayerMessage } from '../dist/lavalink/playerUI.js';
import { resolveRecoveryTrack } from '../dist/services/recovery.js';
import { resolveTrackQuery, smartSearch } from '../dist/commands/play.js';
import { initLavalink } from '../dist/lavalink/client.js';
import CryptoJS from 'crypto-js';

const info = (title = 'Anthaathi', identifier = '29WzIwFvVdg') => ({ title, identifier, author: 'Govind Vasantha', duration: 240000, sourceName: 'youtube', isSeekable: true, isStream: false, uri: `https://www.youtube.com/watch?v=${identifier}` });
const jio = (title, id, extra = {}) => ({ title, id, artist: 'Govind Vasantha', duration: 240, language: 'tamil', has320kbps: true, streamUrl: `https://example.com/${id}.mp4`, ...extra });

test('YouTube link forms resolve one exact ID, including watch links with playlists', async () => {
  for (const url of ['https://youtu.be/29WzIwFvVdg?si=abc', 'https://music.youtube.com/watch?v=29WzIwFvVdg&list=PLabc', 'https://youtube.com/shorts/29WzIwFvVdg']) {
    assert.equal(youtubeVideoId(url), '29WzIwFvVdg');
    assert.deepEqual(await resolveTrackQuery(url), { query: 'https://www.youtube.com/watch?v=29WzIwFvVdg', isUrl: true });
  }
  assert.equal(youtubeVideoId('https://youtube.com.evil.test/watch?v=29WzIwFvVdg'), null);
  assert.equal(youtubeVideoId('https://youtube.com/playlist?list=PLabc'), null);
});

test('direct-link search rejects the wrong video even if its title says Anthaathi', async t => {
  const timer = t.mock.method(globalThis, 'setInterval', () => ({ unref() {} }));
  const manager = initLavalink({ guilds: { cache: new Map() }, channels: { cache: new Map() } });
  timer.mock.restore();
  manager.nodeManager.nodes.clear();
  const wrong = { encoded: 'wrong', info: info('Anthaathi', 'wrongSong12') };
  const exact = { encoded: 'right', info: info() };
  const first = { id: 'first', connected: true, search: async () => ({ tracks: [wrong] }) };
  const second = { id: 'second', connected: true, search: async () => ({ tracks: [wrong, exact] }) };
  manager.nodeManager.nodes.set('second', second);
  const result = await smartSearch({ node: first, playing: true }, 'https://youtu.be/29WzIwFvVdg', true, {});
  assert.deepEqual(result.tracks, [exact]);
  assert.equal(exact.userData.requestedVideoId, '29WzIwFvVdg');
  manager.nodeManager.nodes.clear();
  assert.equal(await smartSearch({ node: first }, 'https://youtu.be/29WzIwFvVdg', true, {}), null);
});

test('card identity comes from the node payload when encoded audio differs', () => {
  const queued = { encoded: 'anthaathi', info: info() };
  const actual = { encoded: 'ram', info: info('The Life of Ram') };
  const manager = { utils: { buildTrack: payload => payload } };
  assert.equal(confirmedTrack(manager, queued, { track: actual }), actual);
  assert.equal(confirmedTrack(manager, queued, { track: queued }), queued);
});

test('seek input rejects malformed/non-finite input and clamps within the song', () => {
  for (const invalid of ['Infinity', '90oops', '1:99', '1:2:3:4', ':30', '', '+NaN', '1.5']) assert.equal(parseSeek(invalid, 30000, 240000), null, invalid);
  assert.equal(parseSeek('1:30', 0, 240000), 90000);
  assert.equal(parseSeek('+30', 50000, 240000), 80000);
  assert.equal(parseSeek('-90', 30000, 240000), 0);
  assert.equal(parseSeek('999', 0, 240000), 239000);
  assert.equal(canSeek({ info: { ...info(), isStream: true } }), false);
});

test('seek tokens change when another recording starts or the same recording restarts', () => {
  let epoch = 1;
  const player = { queue: { current: { encoded: 'one' } }, getData: () => epoch };
  const first = seekToken(player);
  player.queue.current.encoded = 'two';
  assert.notEqual(seekToken(player), first);
  player.queue.current.encoded = 'one';
  epoch++;
  assert.notEqual(seekToken(player), first);
});

test('player UI contains artist, bounded timeline, and disabled seeking for live streams', () => {
  const current = { encoded: 'one', info: info(), userData: { isAutoplay: true } };
  const player = { queue: { current, tracks: [], previous: [] }, getData: () => undefined, position: 20000, volume: 80, repeatMode: 'off', voiceChannelId: '123' };
  const ui = buildPlayerMessage(player);
  assert.match(ui.embeds[0].toJSON().description, /Govind Vasantha/);
  assert.match(ui.embeds[0].toJSON().description, /Autoplay radio/);
  const rows = ui.components.map(r => r.toJSON());
  assert.equal(rows.length, 4);
  assert.equal(rows[2].components[0].options.length, 20);
  assert.ok(rows[2].components[0].options.every(o => Number(o.value) < current.info.duration));
  current.info.isStream = true;
  const liveRows = buildPlayerMessage(player).components.map(r => r.toJSON());
  assert.equal(liveRows.length, 3);
  assert.ok(liveRows[1].components.slice(0, 3).every(b => b.disabled));
});

test('Jio radio excludes seed, history, wrong language, covers, and unknown artists before quality ranking', () => {
  const high = jio('Kaathalae Kaathalae', 'high');
  const low = jio('Thaabangale', 'low', { has320kbps: false });
  const tracks = [low, jio('Anthaathi (From "96")', 'seed'), jio('The Life of Ram', 'history'), jio('Something Else', 'hindi', { language: 'hindi' }), jio('Cover Song (Cover)', 'cover'), jio('Another Song', 'unknown', { artist: 'Unknown' }), high];
  assert.deepEqual(rankJioSaavnRecommendations(tracks, 'Anthaathi', 'Govind Vasantha', 'tamil', new Set(['history']), []), [high, low]);
  assert.deepEqual(rankJioSaavnRecommendations([high], 'Anthaathi', '', 'tamil', new Set(), ['Kaathalae Kaathalae']), []);
});

test('Jio CDN load rejects a different file instead of relabeling it as the requested song', async () => {
  const requested = jio('Anthaathi', 'wanted');
  const wrong = { encoded: 'wrong', info: { identifier: 'https://example.com/wrong.mp4' } };
  const badNode = { id: 'bad', connected: true, search: async () => ({ tracks: [wrong] }) };
  assert.equal(await loadJioSaavnAsLavalinkTrack(requested, {}, [badNode]), null);
  assert.equal(wrong.info.title, undefined);
  const goodNode = { id: 'good', connected: true, search: async () => ({ tracks: [{ encoded: 'good', info: { identifier: requested.streamUrl, sourceName: 'http' } }] }) };
  const loaded = await loadJioSaavnAsLavalinkTrack(requested, {}, [badNode, goodNode]);
  assert.equal(loaded.track.info.title, 'Anthaathi');
  assert.equal(loaded.track.userData.jioId, 'wanted');
  assert.equal(loaded.track.info.sourceName, 'http');
});

test('exact video recovery cannot switch to a title match or another song', async () => {
  const original = { info: info(), userData: { requestedVideoId: '29WzIwFvVdg' } };
  const calls = [];
  const badNode = { id: 'bad', connected: true, search: async opts => { calls.push(opts); return { tracks: [{ info: info('Anthaathi', 'wrongSong12') }] }; } };
  assert.equal(await resolveRecoveryTrack(original, [badNode], () => true), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, undefined);
  const exact = { info: info(), encoded: 'exact' };
  const goodNode = { id: 'good', connected: true, search: async () => ({ tracks: [exact] }) };
  assert.equal((await resolveRecoveryTrack(original, [goodNode], () => true)).track, exact);
});

test('recovery result is discarded when a newer playback starts while search is pending', async () => {
  let active = true, release;
  const pending = new Promise(resolve => { release = resolve; });
  const original = { info: info(), userData: { requestedVideoId: '29WzIwFvVdg' } };
  const node = { id: 'pending', connected: true, search: async () => { await pending; return { tracks: [{ info: info() }] }; } };
  const result = resolveRecoveryTrack(original, [node], () => active);
  active = false;
  release();
  assert.equal(await result, null);
});

test('Jio autoplay uses actual catalog language and 320 availability through the fetch path', async t => {
  const encrypted = CryptoJS.DES.encrypt('https://example.com/audio_160.mp4', CryptoJS.enc.Utf8.parse('38346591'), { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
  const raw = (title, id, language, quality) => ({ title, id, primary_artists: 'Artist', language, duration: '240', encrypted_media_url: encrypted, '320kbps': quality });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ results: [raw('Seed Song', 'seed', 'kannada', true), raw('Other Language', 'other', 'tamil', true), raw('Low Quality', 'low', 'kannada', false), raw('Next Song', 'next', 'kannada', true)] })));
  const result = await findJioSaavnAutoplay('Seed Song', 'Artist', 'kannada', new Set(['seed']));
  assert.equal(result.id, 'next');
  assert.equal(result.language, 'kannada');
  assert.equal(result.has320kbps, true);
});

test('transient stream failures expire instead of hiding songs until restart', async () => {
  const { RecentFailures } = await import('../dist/utils/playback.js');
  let now = 1000;
  const failures = new RecentFailures(3000, () => now);
  failures.add('video');
  assert.equal(failures.has('video'), true);
  now = 4000;
  assert.equal(failures.has('video'), false);
});

test('unrecoverable exact links do not trigger JioSaavn or generic search', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No catalog fallback allowed'); });
  let searches = 0;
  const original = { info: info(), userData: { requestedVideoId: '29WzIwFvVdg' } };
  const node = { id: 'restricted', connected: true, search: async opts => {
    searches++;
    assert.equal(opts.source, undefined);
    throw new Error('This video requires login');
  } };
  assert.equal(await resolveRecoveryTrack(original, [node, node], () => true), null);
  assert.equal(searches, 1);
});

test('a delayed mismatched start event cannot overwrite a newer live node recording', async () => {
  const { lavalink } = await import('../dist/lavalink/client.js');
  const current = { encoded: 'requested', info: info(), userData: { requestedVideoId: '29WzIwFvVdg' } };
  const stale = { encoded: 'stale', info: info('The Life of Ram', 'wrongSong12') };
  const data = new Map();
  let pauses = 0;
  const player = { guildId: 'stale-start', queue: { current }, node: { fetchPlayer: async () => ({ track: current }) }, getData: k => data.get(k), setData: (k,v) => data.set(k,v), pause: async () => { pauses++; } };
  await lavalink.listeners('trackStart')[0](player, current, { track: stale });
  assert.equal(player.queue.current, current);
  assert.equal(pauses, 0);
});

test('confirmed wrong video corrects displayed metadata and pauses an explicit-link request', async () => {
  const { lavalink } = await import('../dist/lavalink/client.js');
  const current = { encoded: 'requested', info: info(), userData: { requestedVideoId: '29WzIwFvVdg' } };
  const actual = { encoded: 'different', info: info('The Life of Ram', 'wrongSong12') };
  const data = new Map();
  let pauses = 0;
  const player = { guildId: 'wrong-start', queue: { current }, node: { fetchPlayer: async () => ({ track: actual }) }, getData: k => data.get(k), setData: (k,v) => data.set(k,v), pause: async () => { pauses++; } };
  await lavalink.listeners('trackStart')[0](player, current, { track: actual });
  assert.equal(player.queue.current.info.title, 'The Life of Ram');
  assert.equal(pauses, 1);
});
