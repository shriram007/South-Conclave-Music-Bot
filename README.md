# 💎 Discord Studio Music Bot (300+ kbps Audiophile Fidelity)

A modern, high-fidelity Discord music bot built with **TypeScript**, **discord.js v14**, and **Lavalink v4**. Designed specifically to deliver **Apple Music & Spotify studio-grade sound (~300+ kbps)** to your Discord voice channels.

---

## 🎯 How to Achieve 300+ kbps Quality in Discord

Discord's voice channels compress incoming audio into **Opus 48,000 Hz Stereo**. To get true studio playback quality, two critical things must happen:

1. **Clean Source Audio (No double-compression):**
   - The bot feeds original high-bitrate audio from **YouTube Music HQ (256 kbps AAC)** and **JioSaavn (320 kbps Studio)** directly into a custom **Opus Level 10 encoder** with 5000ms jitter buffering.
   - Accepts **Spotify** and **Apple Music** song/album/playlist URLs, resolving them automatically to the cleanest matching audio stream.

2. **Discord Voice Channel Bitrate Slider:**
   - Standard Discord servers support up to **96 kbps**.
   - Boost Tier 1 servers support up to **128 kbps**.
   - Boost Tier 2 servers support up to **256 kbps**.
   - Boost Tier 3 servers support up to **384 kbps** (True Studio Sound!).
   - 👉 **Crucial Tip:** Right-click your Voice Channel in Discord → **Edit Channel** → **Overview** → Drag the **Bitrate slider** to the maximum available!

---

## 🚀 Features

- 🎧 **High-Fidelity Audio Pipeline:** 48,000 Hz native stereo, Level 10 Opus encoder, high-resolution resampling.
- 🔗 **Universal Source Support:**
  - **Spotify** tracks, albums, and playlists.
  - **Apple Music** songs and playlists.
  - **YouTube Music** & YouTube search.
  - **JioSaavn** (320 kbps streaming for Indian & International songs).
  - **SoundCloud** HQ.
- 🎛️ **Interactive Now Playing Card:**
  - Live progress bar: `🔘──────── 01:23 / 03:45`
  - High-resolution album artwork thumbnail
  - Source quality badge (`🎧 YouTube Music HQ 256k`, `💎 JioSaavn Hi-Fi 320k`, `🟢 Spotify Stream`)
  - Clickable control buttons:
    - ⏯️ **Play / Pause**
    - ⏭️ **Skip**
    - ⏮️ **Previous Track**
    - 🔁 **Loop Mode (Track / Queue / Off)**
    - 🔀 **Shuffle**
    - 🔉 / 🔊 **Volume +/-**
    - 💎 **Hi-Fi Studio Equalizer**
    - ⏹️ **Stop & Clear**
- 🔊 **Studio Equalizer Presets (`/filter`):**
  - `Hi-Fi Studio`: Boosts dynamics, tightens low bass, sparkles highs.
  - `Bass Boost`: Deep punchy low-end.
  - `Treble Boost`: Vocal clarity and presence.
  - `8D Audio`: Binaural 360-degree rotating surround effect.
  - `Nightcore`: Fast tempo & pitch.
  - `Vaporwave`: Slowed, dreamy aesthetic.
- 📊 **Bitrate Inspector (`/quality`):** Checks your server's current voice channel bitrate and guides you on how to unlock maximum fidelity.

---

## 🛠️ Step-by-Step Setup Guide

### 1. Prerequisites (macOS)
Make sure **Node.js** (v18+) and **Java 21** are installed.

On macOS with Homebrew, install Java 21 with:
```bash
brew install openjdk@21
```
Add Java to your PATH if prompted, or verify:
```bash
java -version
```

---

### 2. Download Lavalink v4
Run the automated downloader script to fetch the latest `Lavalink.jar`:
```bash
npm run setup:lavalink
```
This downloads `Lavalink.jar` directly into the `lavalink/` directory.

---

### 3. Create Discord Bot & Configure `.env`
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**, give it a name, and go to the **Bot** tab.
3. Click **Reset Token** and copy the token.
4. Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent**.
5. Go to the **OAuth2** tab → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: `Connect`, `Speak`, `Send Messages`, `Embed Links`, `Use External Emojis`, `View Channel`
   - Copy the generated URL and open it in your browser to invite the bot to your server.
6. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
7. Fill in:
   - `DISCORD_TOKEN=your_token_here`
   - `CLIENT_ID=your_bot_client_id`
   - *(Optional for Spotify Links)*: Get a free Spotify Client ID & Secret at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).

---

### 4. Start the Music Bot

Open two terminal tabs:

**Terminal 1 (Audio Engine - Lavalink):**
```bash
cd lavalink
java -jar Lavalink.jar
```
*(On first launch, Lavalink will automatically download the LavaSrc and YouTube plugins and initialize on port 2333).*

**Terminal 2 (Discord Bot):**
```bash
npm run build
npm start
```
*(Or use `npm run dev` for instant development with auto-reload).*

---

## 📋 Slash Commands Reference

| Command | Description |
|---|---|
| `/play <query>` | Play any song, album, or playlist (Spotify, Apple Music, YouTube Music, JioSaavn) |
| `/pause` | Pause current playback |
| `/resume` | Resume playback |
| `/skip` | Skip to the next song in the queue |
| `/previous` | Replay the previous song |
| `/stop` | Stop playback, clear queue, and leave voice channel |
| `/seek <time>` | Jump to timestamp (e.g. `1:30` or `90`) |
| `/volume <0-200>` | Adjust software volume normalization |
| `/loop <off\|track\|queue>` | Toggle repeat mode |
| `/shuffle` | Randomize the upcoming queue order |
| `/queue [page]` | View upcoming songs and total duration |
| `/nowplaying` | Show interactive card with control buttons |
| `/filter <preset>` | Apply Studio Hi-Fi EQ, Bass Boost, 8D, Nightcore, etc. |
| `/quality` | Inspect current voice channel bitrate & optimization tips |
| `/help` | Display command overview |

---

## 💎 License
MIT
