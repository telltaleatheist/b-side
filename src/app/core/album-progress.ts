import type { AlbumMeta } from '@shared/types';

/** Where an album being made has got: a line to show and how far along the whole job is (0..1). */
export interface AlbumProgress {
  readonly label: string;
  readonly share: number;
  /** True while a step has no count of its own (the plan): the bar slides instead of filling. */
  readonly waiting: boolean;
}

/** How much of the bar the steps before the tracks take: the plan, then (sung) the lyrics. */
const PLAN_SHARE = 0.05;
const LYRICS_SHARE = 0.15;

/**
 * One album's progress, as Owen asked (2026-10-05: "a progress bar with an
 * indication of what it's doing"): planning, writing lyrics N of M, making the
 * music, painting the art. The music itself is most of the bar.
 */
export function albumProgress(album: AlbumMeta): AlbumProgress {
  const target = album.ask.minutes * 60;
  const before = PLAN_SHARE + (album.ask.sung ? LYRICS_SHARE : 0);
  const music = Math.min(1, album.madeS / target);
  const art = album.coverState === 'painting' ? ' · painting the album art…' : '';
  switch (album.stage) {
    case 'planning': {
      const step = album.step;
      if (step?.kind === 'lyrics') {
        return {
          label: `Writing lyrics: ${step.done + 1} of ${step.of}…`,
          share: PLAN_SHARE + LYRICS_SHARE * (step.done / Math.max(1, step.of)),
          waiting: false,
        };
      }
      return { label: 'Planning the album: its name, the tracks and the cover…', share: 0, waiting: true };
    }
    case 'cover':
    case 'making': {
      const minutes = Math.floor(album.madeS / 60);
      return {
        label: `Making the music: ${minutes} of ${album.ask.minutes} min${art || (album.cover === null && album.coverState == null ? ' · the album art comes next…' : '')}`,
        share: before + (1 - before) * music,
        waiting: false,
      };
    }
    case 'done':
      return { label: 'Done', share: 1, waiting: false };
    case 'stopped':
      return { label: 'Stopped', share: before + (1 - before) * music, waiting: false };
    case 'failed':
      return { label: 'Stopped by a problem', share: before + (1 - before) * music, waiting: false };
  }
}

/** Why an album has no painted cover, when that is worth saying. */
export function coverNote(album: AlbumMeta): string | null {
  if (album.cover !== null) return null;
  if (album.coverState === 'no_model') return 'No cover: this server has no image model installed.';
  if (album.coverState === 'failed') return 'The cover did not paint; the drawn one stands in.';
  return null;
}
