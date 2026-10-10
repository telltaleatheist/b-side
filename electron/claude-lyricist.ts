/**
 * claude-lyricist — lyrics from Claude Sonnet 5.5 through Claude Code on this computer
 * (`claude -p`), the stand-in while B-Sides' own model is retrained (shared/core/lyricist.ts).
 *
 * The person's own Claude Code sign-in pays for it; nothing here holds a key. Each call is one
 * turn with no tools, no saved session and no settings files (so no project or user
 * CLAUDE.md rides along), the song on stdin (never an argument a shell could read), and the
 * answer held to a JSON schema (`structured_output`).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Refusal } from './refusal';
import { CLAUDE_LYRICS_SCHEMA, claudeLyricsSystem, claudeLyricsUser, type Lyricist, type SongToWrite } from '../shared/core/lyricist';

export const CLAUDE_LYRICS_MODEL = 'claude-sonnet-5-5';
/** A song's words take Sonnet seconds; a cold Claude Code start a few more. */
const CALL_MS = 3 * 60_000;

/**
 * Where Claude Code's own executable is. On Windows npm installs a `claude.cmd` shim, which only
 * a shell can run; the real `claude.exe` sits in its package beside it, and that is what is
 * started (no shell, so nothing in a song can be read as a command). Null when not installed.
 */
export function findClaude(): string | null {
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '');
  // A GUI app on a Mac does not inherit the shell's PATH: Claude Code's usual homes too.
  dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      const exe = path.join(dir, 'claude.exe');
      if (fs.existsSync(exe)) return exe;
      if (fs.existsSync(path.join(dir, 'claude.cmd'))) {
        const packaged = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
        if (fs.existsSync(packaged)) return packaged;
      }
    } else {
      const bin = path.join(dir, 'claude');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

export function claudeLyricist(): Lyricist {
  return {
    name: CLAUDE_LYRICS_MODEL,
    write: (song) => writeWithClaude(song),
  };
}

async function writeWithClaude(song: SongToWrite): Promise<string> {
  const claude = findClaude();
  if (claude === null) {
    throw new Refusal('claude_missing', 'Claude Code (`claude`) is not installed on this computer, so it cannot write lyrics. Install it and sign in, or switch the lyrics writer back to the B-Sides model in Settings.');
  }
  const args = [
    '-p',
    '--model', CLAUDE_LYRICS_MODEL,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--system-prompt', claudeLyricsSystem(),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(CLAUDE_LYRICS_SCHEMA),
  ];
  const out = await new Promise<string>((resolve, reject) => {
    // Its own working folder: nothing of a project is near it.
    const child = spawn(claude, args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Refusal('claude_slow', `Claude did not answer within ${CALL_MS / 60_000} minutes.`));
    }, CALL_MS);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Refusal('claude_failed', `Claude Code could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString('utf8');
      if (code === 0 || text.trim().startsWith('{')) resolve(text);
      else reject(new Refusal('claude_failed', `Claude Code stopped (${code}): ${Buffer.concat(stderr).toString('utf8').trim().slice(0, 300) || text.slice(0, 300)}`));
    });
    child.stdin.end(claudeLyricsUser(song), 'utf8');
  });
  let answer: { is_error?: boolean; result?: string; structured_output?: { lyrics?: unknown } };
  try {
    answer = JSON.parse(out) as typeof answer;
  } catch {
    throw new Refusal('claude_failed', `Claude Code answered something that is not its JSON: ${out.slice(0, 200)}`);
  }
  if (answer.is_error) throw new Refusal('claude_failed', `Claude could not write the lyrics: ${String(answer.result ?? 'no reason given').slice(0, 300)}`);
  const lyrics = answer.structured_output?.lyrics;
  if (typeof lyrics !== 'string' || lyrics.trim() === '') throw new Refusal('claude_failed', 'Claude answered without lyrics.');
  return lyrics.trim();
}
