# Playback audit and verification

Changes are local, with compiled `dist` refreshed. The bot has not been restarted or deployed, and no Discord messages were sent during testing.

## Findings addressed

- **Wrong recording substitution:** title matching now preserves the song from Indian album/video titles, retains Unicode, and rejects character-overlap matches such as `Silent` / `Listen`. Recovery and catalog substitutions check title, available artist/album metadata, version, and duration. Anthaathi cannot match The Life of Ram merely because the composer or album matches.
- **Unofficial autoplay choices:** recognized label and Topic/VEVO author signals rank above generic uploads. Covers, slowed edits, remixes, karaoke, and other unrequested versions are excluded. These are metadata heuristics, not cryptographic verification of the uploader.
- **Provider priority:** text search prefers YouTube Music before regional alternatives. Recovery tries the same URL, then matching YTM/JioSaavn catalog recordings, then recognized YouTube uploads; it does not automatically recover through arbitrary SoundCloud uploads. Explicit URLs retain the selected recording. `/jio` and JioSaavn-seeded radio retain their dedicated regional behavior.
- **Stale autoplay:** in-flight recommendations are shared for the same player/seed. Results are discarded after disabling autoplay, changing the seed, purging for a user request, destroying the player, or adding queued songs. Turning autoplay off removes already queued radio tracks.
- **Stale recovery:** recovery checks player identity and playback generation before replacing audio. Retry counts follow the recovered track instead of unrelated songs. Same-URL recovery on another node is no longer prevented by the global failed-ID set.
- **Double skip:** `lavalink-client` already advances after a stuck event; the bot no longer skips a second time.
- **Player cards:** new cards use current playback state after awaited Discord work; message edits remain serialized instead of releasing their lock while a timed-out edit is still running.
- **False quality reporting:** `/quality`, `/ping`, source badges and queue tags no longer invent a source bitrate, lossless stream, fixed 180 ms latency, or zero network loss. Standard Lavalink track metadata does not contain measured source bitrate.
- **Normalization:** unsupported nodes now report failure instead of reducing all audio by 5% and calling it ReplayGain. Disabling normalization removes that filter without removing EQ. Setting volume to 100 no longer resets filters.
- **Hi-Fi EQ:** gentler low-mid cuts retain more bass/presence than the previous preset. Listening quality still needs an A/B check; EQ cannot restore detail missing from an upload.
- **JioSaavn:** request the 320 URL only when its availability flag is true. Missing language no longer silently becomes Tamil. Spelling suggestions must still match the original requested recording.
- **Lifecycle:** session saving runs before shutdown exits; zero volume survives restoration; restoration listener is installed before node initialization; empty-channel disconnect rechecks 24/7 mode.
- **Custom node:** explicitly configured localhost/private nodes are usable, including search/recovery. Searching for a queued song no longer migrates an actively playing player. The large fixed public-node preference was reduced so load metrics matter.

## Exact links, seek controls, and JioSaavn follow-up

- Pasted YouTube watch/short links mean **one exact video ID**, including links containing a playlist parameter. Use a playlist-only URL to queue a YouTube playlist. Failed exact links never turn into a different song selected by title search.
- Track-start handling compares the event's encoded track with the queue. On a mismatch it queries the node's live player state before correcting metadata, avoiding stale events. A confirmed different video for an explicit link is paused and reported. This addresses an observed code path, not proof of what happened in the original listening incident.
- Recovery searches have a 14-second selection budget, bounded node requests, two retries per recovery chain, and seekable-track position restoration. A failed player PATCH no longer leaves the recovery candidate as the displayed current track. Temporary failed-ID cooldowns expire after three minutes.
- The player now shows artist, source, volume, repeat, and queue state with a compact timeline. Seek offers 20 timestamp positions (5% steps), ±15 seconds, and exact/relative timestamp input. Controls are tied to the current recording/start event, so an old modal cannot seek a new song. Live/nonseekable tracks disable seeking. Discord's [message components](https://docs.discord.com/developers/components/reference) do not include a draggable range slider.
- `/jio` is the short command; `/jiosaavn` remains an alias. A failed strict match no longer falls through to the first search result. JioSaavn URL resolution no longer guesses a song from the slug. HTTP loads must resolve the exact CDN URL before catalog metadata is applied.
- JioSaavn radio uses catalog language metadata (including Kannada), excludes the seed/history/queued IDs, rejects edits and unknown-artist entries, and ranks available 320 kbps tracks first. JioSaavn radio stays in that catalog; no acceptable result means the queue ends.
- `/quality` includes playing/requested IDs and the node-reported YouTube plugin version for diagnosis.

## Node configuration and actual audio quality

The log supplied with the request shows YouTube playback authorization/client failures. It does not demonstrate a measured bitrate drop. A successful catalog search also does not prove the node can open the stream.

The local YAML now uses the official `dev.lavalink.youtube:youtube-plugin` artifact, pinned to 1.18.2, with MUSIC for search and WEB/ANDROID_VR for playback. This is a configuration update, not a verified Java deployment. The repo's downloader still pins Lavalink 4.0.8; validate the complete server/plugin combination in staging before using the local server in production.

The upstream documentation identifies MUSIC as search-only and ANDROID as frequently dysfunctional. See [youtube-source client documentation](https://github.com/lavalink-devs/youtube-source#available-clients) and [release 1.18.2](https://github.com/lavalink-devs/youtube-source/releases/tag/1.18.2).

`opusEncodingQuality: 10`, `resamplingQuality: HIGH`, and `frameBufferDurationMs: 5000` are already configured locally. A frame buffer reduces some stalls; it does not guarantee uninterrupted audio. These settings affect only a server launched with this YAML, not Kasawa/Millo/Serenetia. See [Lavalink configuration](https://lavalink.dev/configuration/config/file).

For control over encoder settings, source-plugin updates, and diagnostics, use your own Lavalink node and set `LAVALINK_HOST`, `LAVALINK_PORT`, `LAVALINK_PASSWORD`, and `LAVALINK_SECURE`. Set `LAVALINK_PUBLIC_FALLBACKS=false` to use only that configured node when you need a controlled pipeline. This trades public-node failover for control over the server configuration. Measure its performance from your actual Discord voice region. Being in India alone does not establish which host will have the best route.

## Validation

The current suite contains 28 passing offline tests.

Run `npm test`: TypeScript build plus offline regression tests for the reported titles, incorrect substitutions, upload ranking, normalization, JioSaavn quality flags, delayed autoplay cancellation, YTM-first search, and single queue advancement after stalls, exact-video recovery, node-confirmed metadata, strict seeking, UI component limits, JioSaavn CDN identity, and JioSaavn language/quality selection. `git diff --check` checks patch whitespace.

Before calling this production-verified, test in a Discord voice channel:

1. Play `https://youtu.be/29WzIwFvVdg` and `Govind Vasantha - Anthaathi`; compare the audio with the current card.
2. Play the supplied VadaChennai URL, then queue a new request while recovery is pending; it must not be replaced by the older recovery.
3. Disable autoplay while a recommendation is pending, and separately after one is queued.
4. Compare flat vs Hi-Fi at the same player/listener volume. Inspect `/quality` and `/ping` during several complete songs.
5. Open Seek, change songs, then submit the old modal: it must refuse. Test the timeline and ±15-second buttons, then verify live streams cannot seek.
6. Start `/jio` radio with a Kannada song and confirm it retains catalog language and does not replay the seed.
7. Force a node stall and confirm exactly one queue advance; restart and confirm session restoration including volume zero.

## Remaining limits

No live provider, Java-node, Discord voice, or listening tests were performed. The matching policy is intentionally conservative: ambiguous artist/album metadata may yield no substitute rather than risk a different recording. Channel names can be spoofed; language inference remains heuristic. Resolving a track in advance prefetches metadata, not decoded audio, so transitions are not guaranteed gapless. Public-node availability, YouTube authorization, and source bitrates are outside this TypeScript process's control.

The wider command/persistence review is not a claim that every path is defect-free. Queue UI indices can become stale between rendering and a user's click; persisted sessions still contain source-specific encoded tracks that may expire; storage writes outside session shutdown remain synchronous. These need separate state/persistence work and integration coverage before promising production-grade reliability.
