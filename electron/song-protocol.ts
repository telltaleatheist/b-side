/**
 * song-protocol — `bside-song://library/<file>`, the library's audio for the player.
 *
 * A scheme of our own rather than file:// URLs (the renderer is served from
 * http://localhost in dev, which cannot load file://) or bytes over IPC (a song
 * is tens of megabytes, and an <audio> element seeks by asking for byte
 * ranges). It answers Range requests with 206, which is what makes the
 * scrubber work on a long song.
 */
import * as fs from 'node:fs';
import { Readable } from 'node:stream';

import { protocol } from 'electron';

import type { Library } from './library';
import { SONG_SCHEME } from '../shared/types';

const MEDIA_TYPES: Record<string, string> = { flac: 'audio/flac', wav: 'audio/wav' };

/** Before app ready: the scheme may stream media and be fetched. */
export function registerSongScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SONG_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  ]);
}

function body(file: string, start: number, end: number): ReadableStream {
  return Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
}

/** After app ready: answer from whatever library folder is current. */
export function serveSongs(library: () => Library): void {
  protocol.handle(SONG_SCHEME, async (request) => {
    let file: string;
    try {
      const url = new URL(request.url);
      file = library().audioPath(decodeURIComponent(url.pathname.replace(/^\/+/, '')));
    } catch (error) {
      return new Response((error as Error).message, { status: 400 });
    }
    let size: number;
    try {
      size = (await fs.promises.stat(file)).size;
    } catch {
      return new Response('That song is no longer in the library.', { status: 404 });
    }
    const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
    const headers: Record<string, string> = {
      'Content-Type': MEDIA_TYPES[extension] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range === null || size === 0) {
      headers['Content-Length'] = String(size);
      return new Response(size === 0 ? null : body(file, 0, size - 1), { status: 200, headers });
    }
    let start: number;
    let end: number;
    if (range[1] === '') {
      // bytes=-N: the last N bytes.
      start = Math.max(0, size - Number(range[2]));
      end = size - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(body(file, start, end), { status: 206, headers });
  });
}
