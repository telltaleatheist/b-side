/**
 * disk — the few file operations B-Sides' song logic needs, so the same logic
 * runs on the desktop (Node's fs, electron/node-disk.ts) and on the phone (the
 * native file plugin, src/app/phone/native-disk.ts).
 *
 * Paths are joined in their root's own style: `\` under a Windows root
 * (`C:\…`, `\\server\…`), `/` everywhere else. Audio never passes through here
 * as bytes on the phone: a song arrives through the job runner's audio fetcher, which writes the file
 * itself (natively on the phone), and is then moved or copied by name.
 */
export interface Disk {
  /** Make a folder and its parents; a folder that is there already is fine. */
  mkdir(dir: string): Promise<void>;
  /** The names in a folder, or null when the folder does not exist. */
  list(dir: string): Promise<string[] | null>;
  /** A text file's contents, or null when there is no such file. */
  readText(file: string): Promise<string | null>;
  /** Write text so an interruption leaves the old file intact (temporary + rename). */
  writeText(file: string, text: string): Promise<void>;
  /** Whether a file exists. */
  exists(file: string): Promise<boolean>;
  /** Rename in place, replacing what is there (one volume: atomic). */
  move(from: string, to: string): Promise<void>;
  /** Copy, replacing what is there; an interrupted copy never sits under `to`. */
  copy(from: string, to: string): Promise<void>;
  /** Remove a file; one that is not there is fine. */
  remove(file: string): Promise<void>;
}

/**
 * Join path parts in the first part's style, without doubled separators: a
 * Windows root (`C:\Music`, `\\nas\share`) joins with `\`, so a path handed to
 * Windows (Explorer's "Show in folder", a refusal's sentence) reads as one.
 */
export function join(...parts: string[]): string {
  const kept = parts.filter((part) => part !== '');
  const windows = kept.length > 0 && /^([A-Za-z]:[\\/]|\\\\)/.test(kept[0] as string);
  const sep = windows ? '\\' : '/';
  const trailing = windows ? /[\\/]+$/ : /\/+$/;
  const edges = windows ? /^[\\/]+|[\\/]+$/g : /^\/+|\/+$/g;
  return kept
    .map((part, at) => (at === 0 ? part.replace(trailing, '') : part.replace(edges, '')))
    .join(sep);
}

/** The last part of a `/`- or `\`-separated path. */
export function basename(file: string): string {
  return file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
}
