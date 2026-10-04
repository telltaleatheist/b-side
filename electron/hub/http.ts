/**
 * http — the small pieces the hub server is built from: JSON in and out, the
 * refusal envelope, files with Range support, and the built web app.
 *
 * `node:http` and nothing else, on purpose: the API is a few dozen routes, and a
 * framework would be the biggest thing in main.
 */
import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';

import { Refusal, refusalOf } from '../refusal';

const MEDIA_TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** The most a JSON body may be: lyrics and a preset are a few kilobytes. */
const MAX_BODY = 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Codes that mean "no such thing", whatever raised them. */
const NOT_FOUND = new Set(['unknown_server', 'song_missing', 'take_missing', 'playlist_missing', 'not_found']);

/** A refusal as the API answers it: the Crucible envelope's shape, `{error: {code, message}}`. */
export function sendRefusal(res: ServerResponse, error: unknown): void {
  const refusal = refusalOf(error);
  let status = error instanceof Refusal && error.status >= 400 ? error.status : 400;
  if (NOT_FOUND.has(refusal.code)) status = 404;
  if (!(error instanceof Refusal)) console.error('[hub] request failed:', error);
  sendJson(res, status, { error: refusal });
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Refusal('body_too_large', 'That request is larger than B-Side accepts.', 413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal('body_not_json', 'The request body is not JSON.');
  }
}

/**
 * Send a file, answering `Range` with 206 so an `<audio>` element (or AVPlayer)
 * can seek. A missing file is a 404 with a sentence, never a crash.
 */
export async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache: string): Promise<void> {
  let size: number;
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
    size = stat.size;
  } catch {
    sendJson(res, 404, { error: { code: 'not_found', message: 'That file is no longer here.' } });
    return;
  }
  const headers: Record<string, string> = {
    'Content-Type': MEDIA_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range !== null && size > 0 && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') {
      // bytes=-N: the last N bytes.
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
    }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', (err) => {
    console.error(`[hub] reading ${file} failed:`, err);
    res.destroy(err);
  });
  // A listener that went away (skipped the song) closes the read.
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * The built web app: a file under `root`, or `index.html` for any path that is
 * not a file (the Angular router's own pages). Nothing outside `root` is served.
 */
export async function sendApp(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): Promise<void> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    sendJson(res, 400, { error: { code: 'path_invalid', message: 'That path is not valid.' } });
    return;
  }
  // Both sides resolved: a root given with forward slashes on Windows must still contain its own files.
  const base = path.resolve(root);
  const file = path.resolve(base, relative);
  if (file !== base && !file.startsWith(base + path.sep)) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'Nothing is served there.' } });
    return;
  }
  const isFile = relative !== '' && (await fs.promises.stat(file).then((s) => s.isFile(), () => false));
  if (isFile) {
    // Angular's file names carry a content hash, except index.html, which must always be fresh.
    await sendFile(req, res, file, /-[A-Z0-9]{8}\.(js|css)$/i.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache');
    return;
  }
  const index = path.join(base, 'index.html');
  if (!fs.existsSync(index)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`B-Side's web app is not built here (${index} is missing). Run "npm run build".`);
    return;
  }
  await sendFile(req, res, index, 'no-cache');
}

/** The most one uploaded file may be: a long FLAC is well under it. */
const MOST_UPLOAD_BYTES = 400_000_000;

/**
 * Stream a request's body to `target`: written beside it, then renamed into
 * place, so a broken upload never sits under the real name.
 */
export async function receiveFile(req: IncomingMessage, target: string): Promise<void> {
  const temporary = `${target}.writing`;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(temporary);
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MOST_UPLOAD_BYTES) {
        req.destroy();
        out.destroy();
        reject(new Refusal('upload_too_big', 'That file is bigger than any song B-Side makes.', 413));
      }
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    req.pipe(out);
  }).catch(async (error: unknown) => {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  });
  await fs.promises.rename(temporary, target);
}
