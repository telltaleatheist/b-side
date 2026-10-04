/**
 * titles — a new song's first title: its first sung line, or what kind of
 * instrumental it is. Renamable once saved.
 */
import type { SongParams } from '../types';

export function defaultTitle(params: SongParams): string {
  const sung = (params.lyrics ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^\[[^\[\]]+\]$/.test(line));
  if (sung !== undefined && !params.instrumental) return sung.length > 60 ? `${sung.slice(0, 57)}...` : sung;
  // "Synthwave · Retro · Driving": the style, read as a name. The seed and "instrumental" are on the song's details line.
  const style = (params.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '' && !/^(instrumental|no vocals|no singing)$/i.test(t))
    .slice(0, 3)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1));
  return style.length > 0 ? style.join(' · ') : params.instrumental ? 'Instrumental' : 'Untitled song';
}
