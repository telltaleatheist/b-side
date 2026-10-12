/**
 * instrumental-model — which model an instrumental is sent to.
 *
 * YuE2's one decoder plans a score and then composes the audio from it, and on an instrumental
 * its composing invents a singer: the planned score's Vocal voice is all rests, the lyrics are
 * only section tags, and the words it sings are in no request. 19 of 21 instrumentals rendered on
 * 2026-10-11 had a voice. No prompt lever (cfg 1.5 or 3, tag wording, empty lyrics) got the test
 * track (Iron Lanterns Rising, 80 s of singing) below 55 s. An instrumental adapter for the
 * composing stage (Mothersuperior/YuE2-instrumental-cot-full-loras, CC BY-NC 4.0 like YuE2-3B)
 * did, on the same score and seed: 7.5 s, 13 s and 24 s of quiet humming over three rolls of
 * metal, and nothing at all three times out of three on soul. Owen, 2026-10-12: the humming is
 * acceptable; the adapter plans badly on its own (one riff for six minutes), so Crucible plans on
 * yue2-3b and composes with the adapter, as its model `yue2-3b-instrumental` (2.0.7).
 *
 * B-Sides names that model for an instrumental when the server lists it installed, and yue2-3b
 * when not; it never swaps silently, so a song's record says what made it. Either way the render
 * lands as made: the separator is no fix (Owen, 2026-10-12: it damages YuE2's audio).
 */
import type { CrucibleClient } from '@crucible/client';

import type { StoredServer } from './servers';
import { INSTRUMENTAL_MODEL, SONG_MODEL } from '../types';

/** How long a server's answer is trusted before it is asked again (the model installed meanwhile). */
const RECHECK_MS = 10 * 60_000;

interface Known {
  readonly has: boolean;
  readonly at: number;
}

/**
 * Whether each server has INSTRUMENTAL_MODEL installed, asked of its model list at most every
 * RECHECK_MS. A server that cannot be asked is taken not to have it; the song then goes to
 * SONG_MODEL, which it did before too. Said once in the log when the answer changes.
 */
export class InstrumentalModelGate {
  private readonly known = new Map<string, Known>();

  constructor(
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly recheckMs = RECHECK_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private keyOf(server: StoredServer): string {
    return `${server.name} ${server.url}`;
  }

  /** The model an instrumental on `server` is sent to. */
  async pick(server: StoredServer, client: CrucibleClient): Promise<string> {
    return (await this.has(server, client)) ? INSTRUMENTAL_MODEL : SONG_MODEL;
  }

  async has(server: StoredServer, client: CrucibleClient): Promise<boolean> {
    const key = this.keyOf(server);
    const known = this.known.get(key);
    if (known !== undefined && this.now() - known.at < this.recheckMs) return known.has;
    let has = false;
    try {
      has = (await client.models()).some((row) => row.id === INSTRUMENTAL_MODEL && row.installed);
    } catch (error) {
      this.log(`[model] could not ask ${server.name} for ${INSTRUMENTAL_MODEL} (${error instanceof Error ? error.message : String(error)}); instrumentals go to ${SONG_MODEL}`);
    }
    this.known.set(key, { has, at: this.now() });
    if (known?.has !== has) {
      this.log(has
        ? `[model] ${server.name} makes instrumentals with ${INSTRUMENTAL_MODEL}`
        : `[model] ${server.name} has no ${INSTRUMENTAL_MODEL}; instrumentals go to ${SONG_MODEL}`);
    }
    return has;
  }
}
