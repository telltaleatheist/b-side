/**
 * claude-writer — Claude Sonnet 5.5 through Claude Code on this computer (`claude -p`), writing
 * everything B-Sides' own model would (tags, album concepts, track lists, regenerated pieces,
 * lyrics) while that model is retrained: the Settings choice "Writing" (shared/core/text-model.ts).
 *
 * The person's own Claude Code sign-in pays for it; nothing here holds a key. Each call is one
 * turn with no tools, no saved session and no settings files (so no project or user CLAUDE.md
 * rides along), the prompt on stdin (never an argument a shell could read), and the answer held
 * to the call's JSON schema (`structured_output`). Temperature is Claude Code's own; it takes none.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Refusal } from './refusal';
import { CLAUDE_LYRICS_SCHEMA, claudeLyricsSystem, claudeLyricsUser, type Lyricist } from '../shared/core/lyricist';
import type { TextModel } from '../shared/core/text-model';

export const CLAUDE_MODEL = 'claude-sonnet-5-5';
/** A call takes Sonnet seconds; a track list of fifteen, or a cold Claude Code start, more. */
const CALL_MS = 4 * 60_000;

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

/**
 * Claude Code's own sign-in is separate from the Claude app's, and it expires; a person who
 * never used a terminal cannot guess that (Victoria's laptop, 2026-10-10: "OAuth session expired
 * and could not be refreshed" read as a bare claude_failed). Said as the fix.
 */
const SIGNED_OUT = /authenticat|oauth|not logged in|log ?in|sign(ed)? ?(in|out)|credential|unauthori[sz]ed|\b401\b/i;

function signedOut(detail: string): Refusal {
  return new Refusal(
    'claude_signed_out',
    'Claude Code on this computer is signed out (its sign-in expires, and it is separate from the Claude app). '
      + 'Open a terminal (PowerShell on Windows, Terminal on a Mac), run `claude auth login`, finish signing in, then try again. '
      + `Claude Code said: ${detail.slice(0, 200)}`,
  );
}

/** Claude writing in B-Sides' model's place: its text calls, its lyricist, and a sign-in check. */
export function claudeWriter(): { readonly text: TextModel; readonly lyricist: Lyricist; check(): Promise<void> } {
  return {
    check: checkSignedIn,
    text: {
      name: CLAUDE_MODEL,
      // The task tag is B-Sides' model's routing, not an instruction: Claude gets the content alone.
      ask: async (request) => ({ content: JSON.stringify(await runClaude(request.system, request.user, request.schema)), truncated: false }),
    },
    lyricist: {
      name: CLAUDE_MODEL,
      async write(song) {
        const answer = await runClaude(claudeLyricsSystem(), claudeLyricsUser(song), CLAUDE_LYRICS_SCHEMA);
        const lyrics = answer['lyrics'];
        if (typeof lyrics !== 'string' || lyrics.trim() === '') throw new Refusal('claude_failed', 'Claude answered without lyrics.');
        return lyrics.trim();
      },
    },
  };
}

/** One `claude -p` turn; its structured answer, or a refusal that says what went wrong. */
async function runClaude(system: string, user: string, schema: object): Promise<Record<string, unknown>> {
  const claude = findClaude();
  if (claude === null) {
    throw new Refusal('claude_missing', 'Claude Code (`claude`) is not installed on this computer, so it cannot write. Install it and sign in, or set Settings → Writing back to the B-Sides model.');
  }
  const args = [
    '-p',
    '--model', CLAUDE_MODEL,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--system-prompt', system,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
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
      if (code === 0 || text.trim().startsWith('{')) {
        resolve(text);
        return;
      }
      const why = Buffer.concat(stderr).toString('utf8').trim() || text;
      reject(SIGNED_OUT.test(why) ? signedOut(why) : new Refusal('claude_failed', `Claude Code stopped (${code}): ${why.slice(0, 300)}`));
    });
    child.stdin.end(user, 'utf8');
  });
  let answer: { is_error?: boolean; result?: string; structured_output?: Record<string, unknown> };
  try {
    answer = JSON.parse(out) as typeof answer;
  } catch {
    throw new Refusal('claude_failed', `Claude Code answered something that is not its JSON: ${out.slice(0, 200)}`);
  }
  if (answer.is_error) {
    const why = String(answer.result ?? 'no reason given');
    if (SIGNED_OUT.test(why)) throw signedOut(why);
    throw new Refusal('claude_failed', `Claude could not write it: ${why.slice(0, 300)}`);
  }
  if (answer.structured_output == null || typeof answer.structured_output !== 'object') {
    throw new Refusal('claude_failed', `Claude answered without the JSON asked for: ${String(answer.result ?? '').slice(0, 200)}`);
  }
  return answer.structured_output;
}

/**
 * Whether Claude Code is installed and signed in (`claude auth status`), asked when the person
 * switches Writing to Claude, so they hear it there rather than on their first song. A sign-in
 * that has expired may still read as signed in here; the first call then says so by name.
 */
async function checkSignedIn(): Promise<void> {
  const claude = findClaude();
  if (claude === null) {
    throw new Refusal('claude_missing', 'Claude Code (`claude`) is not installed on this computer, so it cannot write. Install it and sign in, or keep Writing on the B-Sides model.');
  }
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(claude, ['auth', 'status'], { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Refusal('claude_slow', 'Claude Code did not say whether it is signed in within 30 seconds.'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Refusal('claude_failed', `Claude Code could not start: ${error.message}`));
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
  let status: { loggedIn?: unknown };
  try {
    status = JSON.parse(out) as typeof status;
  } catch {
    throw new Refusal('claude_failed', `Claude Code did not say whether it is signed in: ${out.slice(0, 200)}`);
  }
  if (status.loggedIn !== true) throw signedOut('not logged in');
}
