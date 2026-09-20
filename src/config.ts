import dotenv from "dotenv";
dotenv.config();

export interface Config {
  discord: {
    token: string;
    clientId: string;
    guildId?: string;
  };
  lavalink: {
    host: string;
    port: number;
    password: string;
    secure: boolean;
    publicFallbacks: boolean;
    customEnabled: boolean;
  };
  spotify: {
    clientId?: string;
    clientSecret?: string;
  };
  deezer: {
    arl?: string;
  };
}

export const config: Config = {
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
    publicFallbacks: process.env.LAVALINK_PUBLIC_FALLBACKS !== "false",
    customEnabled: process.env.LAVALINK_CUSTOM_ENABLED !== "false",
  },
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  },
  deezer: {
    arl: process.env.DEEZER_ARL,
  },
};
