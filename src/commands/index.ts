import { playCommand } from "./play.js";
import {
  clearCommand,
  loopCommand,
  pauseCommand,
  previousCommand,
  removeCommand,
  resumeCommand,
  seekCommand,
  shuffleCommand,
  skipCommand,
  stopCommand,
} from "./controls.js";
import { queueCommand } from "./queue.js";
import { nowplayingCommand } from "./nowplaying.js";
import { volumeCommand } from "./volume.js";
import { filterCommand } from "./filters.js";
import { qualityCommand } from "./quality.js";
import { helpCommand } from "./help.js";
import { prefixCommand } from "./prefix.js";
import { twentyFourSevenCommand } from "./twentyFourSeven.js";
import { lyricsCommand } from "./lyrics.js";
import { cleanCommand } from "./clean.js";
import { pingCommand } from "./ping.js";

export const commands = [
  playCommand,
  pauseCommand,
  resumeCommand,
  skipCommand,
  removeCommand,
  clearCommand,
  previousCommand,
  stopCommand,
  loopCommand,
  shuffleCommand,
  seekCommand,
  queueCommand,
  nowplayingCommand,
  lyricsCommand,
  volumeCommand,
  filterCommand,
  qualityCommand,
  helpCommand,
  cleanCommand,
  pingCommand, // Hidden from /help command as requested
  // prefixCommand, // Hidden for now (requires Privileged Message Content Intent)
  twentyFourSevenCommand,
];

export const commandMap = new Map<string, any>();
for (const cmd of commands) {
  commandMap.set(cmd.data.name, cmd);
}
