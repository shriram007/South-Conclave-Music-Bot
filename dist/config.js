import dotenv from "dotenv";
dotenv.config();
export const config = {
    discord: {
        token: process.env.DISCORD_TOKEN || "",
        clientId: process.env.CLIENT_ID || "",
        guildId: process.env.GUILD_ID || undefined,
    },
    lavalink: {
        host: process.env.LAVALINK_HOST || "localhost",
        port: parseInt(process.env.LAVALINK_PORT || "2333", 10),
        password: process.env.LAVALINK_PASSWORD || "youshallnotpass",
        secure: process.env.LAVALINK_SECURE === "true",
    },
    spotify: {
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    },
    deezer: {
        arl: process.env.DEEZER_ARL,
    },
};
