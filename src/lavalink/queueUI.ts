import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from "discord.js";
import { Player } from "lavalink-client";
import { formatDuration, getSourceInfo } from "../utils/formatters.js";

export interface QueueMessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<any>[];
}

/**
 * Builds the interactive queue management message matching FlaviBot layout.
 * Allows users to inspect tracks, select any song in the queue, and perform actions:
 * [ 🗑️ Remove ] [ ∧ +1 ] [ ⊼ Top ] [ ∨ -1 ] [ ▶⏸️ Play Now ]
 */
export function buildQueueMessage(
  player: Player,
  page: number = 0,
  selectedIndex: number = 0,
  initiatorName?: string
): QueueMessagePayload {
  const userTracks = player.queue.tracks.filter((t) => {
    const isAutoplay = (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
    return !isAutoplay;
  });
  const current = player.queue.current;
  const pageSize = 5;
  const totalPages = Math.max(1, Math.ceil(userTracks.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));

  // Compute total duration of remaining queue
  const totalMs = userTracks.reduce((acc, t) => acc + (t.info.duration || 0), 0);
  const startIdx = safePage * pageSize;
  const pageTracks = userTracks.slice(startIdx, startIdx + pageSize);

  // Ensure selectedIndex is within valid range for current page
  const safeSelected = Math.max(0, Math.min(selectedIndex, Math.max(0, pageTracks.length - 1)));
  const absoluteSelectedIdx = startIdx + safeSelected;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      userTracks.length > 0
        ? `(${userTracks.length}) songs in queue for ${formatDuration(totalMs)}`
        : "Queue is empty"
    );

  let desc = "";

  if (current) {
    const currSource = getSourceInfo(current.info.sourceName, current.info.uri, current.userData);
    const currTag = currSource.name.includes("JioSaavn") ? "💎 JioSaavn" : (current.info.sourceName === "spotify" ? "🟢 Spotify" : "🎧 YT Music");
    desc += `**Now Playing:** [${current.info.title.substring(0, 48)}](${current.info.uri || "https://discord.com"}) • \`${formatDuration(current.info.duration || 0)}\` • ${currTag} (\`${currSource.command}\`)\n\n`;
  }

  if (pageTracks.length === 0) {
    const isAutoplay = Boolean(player.getData("autoplay") ?? true);
    const bufferedAutoplay = player.queue.tracks.find((t) => {
      return (t.requester as any)?.displayName === "📻 Autoplay Radio" || (t.requester as any)?.username === "Autoplay Radio" || (t.userData as any)?.isAutoplay;
    });

    if (bufferedAutoplay) {
      desc += `📻 **Autoplay Radio (Playing Next):**\n🎶 [${bufferedAutoplay.info.title}](${bufferedAutoplay.info.uri || ""}) • \`${formatDuration(bufferedAutoplay.info.duration || 0)}\`\n*by ${bufferedAutoplay.info.author}*\n\n💡 *Add songs anytime using \`/play <song>\`.*`;
    } else if (isAutoplay) {
      desc += "📻 **Autoplay Radio Active:** The queue is clear, but similar songs will stream automatically!\n💡 *Add songs anytime using `/play <song>`.*";
    } else {
      desc += "ℹ️ Queue is currently empty. Use `/play` or `/jio` to add tracks!";
    }
  } else {
    pageTracks.forEach((t, i) => {
      const num = startIdx + i + 1;
      const isTarget = i === safeSelected;
      const title = t.info.title.substring(0, 45);
      const author = (t.info.author || "Unknown Artist").substring(0, 30);
      const dur = formatDuration(t.info.duration || 0);
      const tSource = getSourceInfo(t.info.sourceName, t.info.uri, t.userData);
      const sourceTag = tSource.name.includes("JioSaavn") ? "💎 JioSaavn" : (t.info.sourceName === "spotify" ? "🟢 Spotify" : "🎧 YT Music");
      const cmdTag = `\`${tSource.command}\``;

      if (isTarget) {
        desc += `**${num}. [${title}](${t.info.uri || ""})** - \`${dur}\`\n*${author}* • ${sourceTag} (${cmdTag})  🔘 **[Selected]**\n\n`;
      } else {
        desc += `**${num}.** [${title}](${t.info.uri || ""}) - \`${dur}\`\n*${author}* • ${sourceTag} (${cmdTag})\n\n`;
      }
    });
  }

  embed.setDescription(desc.trim());
  embed.setFooter({
    text: `Page ${safePage + 1}/${totalPages} • ${userTracks.length} songs • ${initiatorName ? `Initiated by @${initiatorName}` : "South Conclave Music"}`,
  });

  const components: ActionRowBuilder<any>[] = [];

  // Row 1: Action Controls for Selected Song
  if (pageTracks.length > 0) {
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`qm_remove_${safePage}_${safeSelected}`)
        .setLabel("🗑️ Remove")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`qm_moveup_${safePage}_${safeSelected}`)
        .setLabel("▲ Up (+1)")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(absoluteSelectedIdx === 0),
      new ButtonBuilder()
        .setCustomId(`qm_top_${safePage}_${safeSelected}`)
        .setLabel("⏫ Top")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(absoluteSelectedIdx === 0),
      new ButtonBuilder()
        .setCustomId(`qm_movedown_${safePage}_${safeSelected}`)
        .setLabel("▼ Down (-1)")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(absoluteSelectedIdx === userTracks.length - 1),
      new ButtonBuilder()
        .setCustomId(`qm_play_${safePage}_${safeSelected}`)
        .setLabel("▶ Play")
        .setStyle(ButtonStyle.Success)
    );
    components.push(row1);

    // Row 2: Track Selection Dropdown (to switch which song to manage on this page)
    if (pageTracks.length > 1) {
      const options = pageTracks.map((t, i) => {
        const num = startIdx + i + 1;
        const opt = new StringSelectMenuOptionBuilder()
          .setLabel(`${num}. ${t.info.title.substring(0, 80)}`)
          .setDescription(`${(t.info.author || "").substring(0, 45)} • ${formatDuration(t.info.duration || 0)}`)
          .setValue(String(i));
        if (i === safeSelected) opt.setDefault(true);
        return opt;
      });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`qm_select_${safePage}`)
        .setPlaceholder(`🔘 Select song to manage (Currently: #${startIdx + safeSelected + 1})`)
        .addOptions(options);

      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));
    }
  }

  // Row 3: Page Navigation & Close Button
  const rowNav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`qm_prev_${safePage}_${safeSelected}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`qm_next_${safePage}_${safeSelected}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId("qm_close")
      .setLabel("✖ Close")
      .setStyle(ButtonStyle.Danger)
  );
  components.push(rowNav);

  return {
    embeds: [embed],
    components,
  };
}
