/**
 * system-probe — what this computer is, measured once and said in one sentence.
 *
 * Ported from Foundry (app/electron/system-probe.ts), cut to the one thing
 * B-Sides uses it for: the line at the top of "Install Crucible on this
 * computer", which tells somebody before they press anything whether this
 * computer has a GPU the song model can run on. YuE2 wants a large NVIDIA card
 * or Apple silicon; a person deserves to read that it has neither before a
 * download of several gigabytes, not after.
 *
 * NULL IS AN ANSWER, NOT ZERO: no `nvidia-smi` means "no NVIDIA driver here",
 * a card whose memory could not be read is a different state, and the sentence
 * says which. Every probe is a spawn with a deadline, so a wedged driver costs
 * eight seconds and a sentence, never a frozen window.
 *
 * Cached for the process: nobody gains VRAM while B-Sides is open.
 */
import { spawn } from 'node:child_process';
import * as os from 'node:os';

/** Long enough for a cold nvidia-smi on a laptop; short enough not to be a hang. */
const PROBE_MS = 8_000;

let cached: string | null = null;

/**
 * Run a command and answer its stdout, or null. Null covers "not on PATH",
 * "exited non-zero" and "never finished" alike: all three mean "this computer
 * will not tell me", and the caller says that one thing.
 */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, PROBE_MS);
    const out: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const text = Buffer.concat(out).toString('utf8').trim();
      finish(text === '' ? null : text);
    });
  });
}

/**
 * The first NVIDIA card's name and memory, or the sentence saying there is none.
 * The first card only: a model loads onto one card, and adding two cards' memory
 * together describes a computer that does not exist.
 */
async function nvidia(): Promise<{ name: string | null; vramMB: number | null } | string> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (out === null) return 'no NVIDIA GPU (nvidia-smi is not on this computer)';
  const first = out.split(/\r?\n/)[0]?.trim() ?? '';
  const [rawName, rawVram] = first.split(',').map((part) => part.trim());
  const vram = Number.parseInt(rawVram ?? '', 10);
  return { name: rawName !== undefined && rawName !== '' ? rawName : null, vramMB: Number.isFinite(vram) && vram > 0 ? vram : null };
}

/** One sentence about this computer, for the install door. */
export async function machineSentence(): Promise<string> {
  if (cached !== null) return cached;
  const gb = (mb: number): string => (mb / 1024).toFixed(1);
  const ramMB = Math.round(os.totalmem() / 1024 / 1024);
  if (process.platform === 'darwin') {
    cached = process.arch === 'arm64'
      ? `Apple silicon with ${gb(ramMB)} GB of unified memory.`
      : `An Intel Mac with ${gb(ramMB)} GB of RAM. Crucible runs on Apple silicon Macs, not Intel ones.`;
    return cached;
  }
  const card = await nvidia();
  if (typeof card === 'string') {
    cached = `${gb(ramMB)} GB of RAM and ${card}. B-Sides' song model runs on a GPU, so this computer can install Crucible but not make songs with it.`;
  } else if (card.vramMB === null) {
    cached = `${card.name ?? 'An NVIDIA GPU'} (nvidia-smi did not say how much memory it has), ${gb(ramMB)} GB of RAM.`;
  } else {
    cached = `${card.name ?? 'An NVIDIA GPU'} with ${gb(card.vramMB)} GB of VRAM, ${gb(ramMB)} GB of RAM.`;
  }
  return cached;
}
