import type { AlbumMeta } from '@shared/types';

/** Where an album being made has got: a line to show and how far along the whole job is (0..1). */
export interface AlbumProgress {
  readonly label: string;
  readonly share: number;
  /** True while a step has no count of its own (the plan): the bar slides instead of filling. */
  readonly waiting: boolean;
}

/** How much of the bar the steps before the music take: the plan, the lyrics (sung), the cover. */
const PLAN_SHARE = 0.05;
const LYRICS_SHARE = 0.2;
const COVER_SHARE = 0.05;

/**
 * One album's progress, as Owen asked (2026-10-05: "a progress bar with an
 * indication of what it's doing"). An album is made in order, everything before
 * the music: planning (names and tags), writing lyrics N of M, painting the
 * album art, then making the music, which is most of the bar.
 */
export function albumProgress(album: AlbumMeta): AlbumProgress {
  const lyricsShare = album.ask.sung ? LYRICS_SHARE : 0;
  const before = PLAN_SHARE + lyricsShare + COVER_SHARE;
  const music = Math.min(1, album.madeS / (album.ask.minutes * 60));
  const musicShare = before + (1 - before) * music;
  switch (album.stage) {
    case 'planning': {
      const step = album.step;
      if (step?.kind === 'lyrics') {
        return {
          label: `Writing lyrics: ${step.done + 1} of ${step.of}…`,
          share: PLAN_SHARE + lyricsShare * (step.done / Math.max(1, step.of)),
          waiting: false,
        };
      }
      if (step?.kind === 'install') {
        return { label: `Setting up the album's writer on the server: ${step.detail ?? 'installing'}…`, share: 0, waiting: true };
      }
      if (step?.kind === 'cover') {
        return { label: 'Painting the album art…', share: PLAN_SHARE + lyricsShare, waiting: false };
      }
      return { label: 'Planning the album: its name, the track titles and their tags…', share: 0, waiting: true };
    }
    case 'cover':
    case 'making':
      return {
        label: `Making the music: ${Math.floor(album.madeS / 60)} of ${album.ask.minutes} min`,
        share: musicShare,
        waiting: false,
      };
    case 'done':
      return { label: 'Done', share: 1, waiting: false };
    case 'stopped':
      return { label: 'Stopped', share: musicShare, waiting: false };
    case 'failed':
      return { label: 'Stopped by a problem', share: musicShare, waiting: false };
  }
}

/**
 * Why an album has no painted cover, when that is worth saying. A server with no image
 * model is not worth saying: its albums have the standard cover, as they should.
 */
export function coverNote(album: AlbumMeta): string | null {
  if (album.cover !== null) return null;
  if (album.coverState === 'failed') return 'The cover did not paint; the drawn one stands in.';
  return null;
}
