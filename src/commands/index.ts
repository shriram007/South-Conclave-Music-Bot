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
  volumeCommand,
  filterCommand,
  qualityCommand,
  helpCommand,
  // prefixCommand, // Hidden for now (requires Privileged Message Content Intent)
  twentyFourSevenCommand,
];

export const commandMap = new Map<string, any>();
for (const cmd of commands) {
  commandMap.set(cmd.data.name, cmd);
}
