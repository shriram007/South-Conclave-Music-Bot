import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import { Player, Track } from 'lavalink-client';
import { createFlaviProgressBar, formatDuration, getSourceInfo } from '../utils/formatters.js';
import { canSeek, seekToken } from '../utils/playback.js';
import { isFavorite } from '../utils/favorites.js';

export interface PlayerMessagePayload {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<any>[];
}

export function buildPlayerMessage(player: Player, track?: Track | null): PlayerMessagePayload {
  const current = track || player.queue.current;
  if (!current) return { embeds: [new EmbedBuilder().setColor(0x5865f2).setDescription('The queue is empty. Use `/play` or `/jio` to add music.')], components: [] };
  const source = getSourceInfo(current.info.sourceName, current.info.uri, current.userData);
  const duration = current.info.duration || 0;
  const seekable = canSeek(current);
  const token = seekToken(player);
  const autoplay = Boolean(player.getData('autoplay') ?? true);
  const preset = (player.getData('filter_preset_key') as string) || 'reset';
  const requester = current.requester as any;
  const requesterId = requester?.id || (current.userData as any)?.userId;
  const isRadio = Boolean((current.userData as any)?.isAutoplay);
  const requestedBy = isRadio ? 'Autoplay radio' : requesterId ? `<@${requesterId}>` : 'Music session';
  const liked = requesterId ? isFavorite(requesterId, current.info.uri) : false;
  const queueCount = player.queue.tracks.filter(t => !(t.userData as any)?.isAutoplay).length;
  const radioNext = player.queue.tracks.some(t => (t.userData as any)?.isAutoplay);
  const embed = new EmbedBuilder()
    .setColor(player.paused ? 0x747f8d : 0x5865f2)
    .setTitle(current.info.title.slice(0, 256))
    .setDescription(`**${player.paused ? 'Paused' : 'Now playing'}** · ${escapeMarkdown(current.info.author || 'Artist unavailable')}\n\n${createFlaviProgressBar(player.position || 0, duration, 16)}\n\n${requestedBy} · <#${player.voiceChannelId}>`)
    .addFields(
      { name: 'Up next', value: `${queueCount} queued${radioNext ? ' · Radio ready' : ''}`, inline: true },
      { name: 'Volume', value: `${player.volume}%`, inline: true },
      { name: 'Repeat', value: player.repeatMode === 'track' ? 'This track' : player.repeatMode === 'queue' ? 'Queue' : 'Off', inline: true },
    )
    .setFooter({ text: `${source.name} · ${player.getData('eq_preset') || 'Flat'}${player.getData('normalized') ? ' · Normalized' : ''}` });
  if (/^https?:\/\//i.test(current.info.uri || '')) embed.setURL(current.info.uri);
  if (/^https?:\/\//i.test(current.info.artworkUrl || '')) embed.setThumbnail(current.info.artworkUrl!);

  const button = (id: string, label: string, disabled = false, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  const transport = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button('player_prev', 'Previous', !player.queue.previous.length),
    button('player_pause_resume', player.paused ? 'Resume' : 'Pause', false, ButtonStyle.Primary),
    button('player_skip', 'Next'),
    button('player_stop', 'Stop'),
    button('player_like', liked ? '♥ Saved' : '♡ Save', isRadio),
  );
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`player_seek_step:${token}:back`, '−15s', !seekable),
    button(`player_seek:${token}`, 'Seek…', !seekable),
    button(`player_seek_step:${token}:forward`, '+15s', !seekable),
    button('player_autoplay', autoplay ? 'Radio: on' : 'Radio: off', false, autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    button('player_queue', `Queue (${queueCount})`),
  );
  const components: ActionRowBuilder<any>[] = [transport, controls];
  if (seekable) {
    const timeline = new StringSelectMenuBuilder().setCustomId(`player_timeline:${token}`).setPlaceholder('Jump to a position in this song');
    timeline.addOptions(Array.from({ length: 20 }, (_, i) => {
      const position = Math.floor(duration * i / 20);
      return { label: `${formatDuration(position)} · ${i * 5}%`, value: String(position) };
    }));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(timeline));
  }
  const presets = [
    { label: 'Flat · original tone', value: 'reset', description: 'No EQ or effects' },
    { label: 'Hi-Fi · gentle clarity', value: 'hifi', description: 'Subtle low-mid cut, original tempo' },
    { label: 'Bass boost', value: 'bassboost', description: 'More low-end emphasis' },
    { label: 'Vocal clarity', value: 'treble', description: 'Emphasize upper frequencies' },
    { label: '8D rotation', value: '8d', description: 'Stereo rotation for headphones' },
    { label: 'Nightcore', value: 'nightcore', description: 'Higher speed and pitch' },
    { label: 'Vaporwave', value: 'vaporwave', description: 'Lower speed and pitch' },
    { label: 'Turbo · 1.35×', value: 'turbo', description: 'Faster playback' },
    { label: 'Karaoke', value: 'karaoke', description: 'Reduce centered vocals' },
  ];
  components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId('player_filter_menu').setPlaceholder('Sound settings').addOptions(presets.map(p => ({ ...p, default: p.value === preset }))),
  ));
  return { embeds: [embed], components };
}
