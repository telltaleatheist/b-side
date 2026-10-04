/**
 * titles — a new song's first title: its first sung line, or what kind of
 * instrumental it is. Renamable once saved.
 */
import type { SongParams } from '../shared/types';

export function defaultTitle(params: SongParams, seed: number): string {
  const sung = (params.lyrics ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^\[[^\[\]]+\]$/.test(line));
  if (sung !== undefined && !params.instrumental) return sung.length > 60 ? `${sung.slice(0, 57)}...` : sung;
  const style = (params.tags ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '').slice(0, 3).join(', ');
  return `${params.instrumental ? 'Instrumental' : 'Song'}${style === '' ? '' : ` — ${style}`} (seed ${seed})`;
}
