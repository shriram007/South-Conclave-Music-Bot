import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LAVALINK_JAR_URL = "https://github.com/lavalink-devs/Lavalink/releases/download/4.0.8/Lavalink.jar";
const LAVALINK_DIR = path.resolve(__dirname, "../lavalink");
const TARGET_PATH = path.join(LAVALINK_DIR, "Lavalink.jar");

if (!fs.existsSync(LAVALINK_DIR)) {
  fs.mkdirSync(LAVALINK_DIR, { recursive: true });
}

console.log(`[Lavalink Setup] Downloading Lavalink.jar v4.0.8...`);
console.log(`Source: ${LAVALINK_JAR_URL}`);
console.log(`Destination: ${TARGET_PATH}`);

function download(url, dest, cb) {
  const file = fs.createWriteStream(dest);
  https.get(url, (response) => {
    // Follow HTTP redirects (e.g. 302 to GitHub AWS S3 bucket)
    if (response.statusCode === 301 || response.statusCode === 302) {
      return download(response.headers.location, dest, cb);
    }

    if (response.statusCode !== 200) {
      return cb(new Error(`Failed to download: HTTP status ${response.statusCode}`));
    }

    const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
    let downloadedBytes = 0;

    response.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes) {
        const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
        process.stdout.write(`\rDownloading: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(1)} MB / ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
    });

    response.pipe(file);

    file.on("finish", () => {
      file.close(() => {
        console.log("\n✅ Download completed successfully!");
        cb(null);
      });
    });
  }).on("error", (err) => {
    fs.unlink(dest, () => {});
    cb(err);
  });
}

download(LAVALINK_JAR_URL, TARGET_PATH, (err) => {
  if (err) {
    console.error("\n❌ Download failed:", err.message);
    process.exit(1);
  }
  console.log("\nNext Steps:");
  console.log("1. Make sure Java 17 or 21 is installed: `brew install openjdk@21`");
  console.log("2. Start Lavalink server: `cd lavalink && java -jar Lavalink.jar`");
  console.log("3. Start your bot: `npm run dev` or `npm start`");
});
