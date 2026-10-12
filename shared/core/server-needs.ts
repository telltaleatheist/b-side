/**
 * server-needs — ask a Crucible for what B-Sides uses beyond YuE2, the way
 * BookForge and Foundry do (Owen, 2026-10-11: "b-sides should request the rvc
 * package when it installs").
 *
 * Neither app tells Crucible's installer who it is: the install is a bare
 * service (`echo`, crucible-install.ts), and each app then reads the server and,
 * when something it needs is missing, posts its own MODULE as a task
 * (`POST /v1/tasks {"type":"module"}`; BookForge electron/crucible/module-setup.ts,
 * Foundry app/electron/crucible-coordinate.ts). A module is the JSON Crucible's
 * `scripts/gen-modules.py` writes from `modules/<app>.toml`; the server runs it
 * as one task and skips what is already installed, so asking twice costs a read.
 *
 * What B-Sides needs beyond YuE2 (which its first song installs, `409
 * installing`): the vocal separator, Crucible's `denoise` verb with the
 * `vocals-roformer` model (voice-check.ts). The verb runs in Crucible's `rvc`
 * environment, which is installed as the `rvc` job type (`denoise` is not an
 * installable type of its own).
 *
 * B_SIDES_MODULE is Crucible's generated `modules/b-sides.module.json` (Crucible 2.0.4,
 * from modules/b-sides.toml; crucible-pc-1, 2026-10-11: `rvc` is right, denoise shares
 * its environment). Its `backends` are the generator's field (both rows exist on cuda-linux and
 * mlx-darwin only, so a Windows-native engine is asked for nothing) and are
 * stripped before posting, because the server refuses unknown keys.
 */
import { CrucibleRefused, type CatalogRow, type CrucibleClient, type CrucibleModule } from '@crucible/client';

import { INSTRUMENTAL_MODEL, SONG_MODEL, type ServerNeedsView } from '../types';

/** The separator B-Sides asks for, by its catalog id. */
export const SEPARATOR_MODEL = 'vocals-roformer';

interface ModuleRow {
  readonly backends?: readonly string[];
}

/**
 * What `modules/b-sides.toml` generates (see the header). Since Crucible 2.0.5 it brings YuE2 as well
 * as the separator (Owen, 2026-10-11: on connecting, ask the server for "the rvc and the yue
 * packages"), turns on each job type it brings, and skips what the card cannot hold (`unmet`).
 * The tag model is left out by design: it installs on its first chat (crucible-pc-1).
 */
export const B_SIDES_MODULE = {
  name: 'b-sides',
  version: '2.0.4+1e1458912f77',
  job_types: [{ type: 'rvc', backends: ['cuda-linux', 'mlx-darwin'] }, { type: 'audio', backends: ['cuda-linux', 'mlx-darwin'] }],
  needs: [],
  subjects: [
    { kind: 'denoise', id: SEPARATOR_MODEL, backends: ['cuda-linux', 'mlx-darwin'] },
    { kind: 'model', id: SONG_MODEL, backends: ['cuda-linux', 'mlx-darwin'] },
    // The instrumental model (Owen, 2026-10-12; Crucible 2.0.7, a 140 MB adapter over yue2-3b):
    // asked for where the server's catalog knows it (knownTo), so an older server is not posted a
    // module it would refuse whole.
    { kind: 'model', id: INSTRUMENTAL_MODEL, backends: ['cuda-linux', 'mlx-darwin'] },
  ],
} as const;

const here = (row: ModuleRow, backend: string): boolean => row.backends === undefined || row.backends.includes(backend);

/** The module for this engine: rows it can hold, rebuilt from their wire fields (BookForge's moduleForBackend). */
export function moduleForBackend(backend: string): CrucibleModule {
  return {
    name: B_SIDES_MODULE.name,
    version: B_SIDES_MODULE.version,
    job_types: B_SIDES_MODULE.job_types.filter((row) => here(row, backend)).map(({ type }) => ({ type })),
    needs: [],
    subjects: B_SIDES_MODULE.subjects.filter((row) => here(row, backend)).map(({ kind, id }) => ({ kind, id })),
  };
}

/**
 * The module with only the subjects this server's catalog knows (a newer one's, such as the
 * instrumental model on a server before 2.0.7, is left out and said in the log), so the post asks
 * for nothing the server cannot name. Job types are not catalog rows and stay.
 */
export function knownTo(module: CrucibleModule, catalog: readonly CatalogRow[], log: (line: string) => void = () => undefined): CrucibleModule {
  const subjects = module.subjects.filter((subject) => {
    const known = catalog.some((row) => row.kind === subject.kind && row.id === subject.id);
    if (!known) log(`[needs] this server's catalog has no ${subject.kind} ${subject.id}; not asked for it`);
    return known;
  });
  return { ...module, subjects };
}

/**
 * What of the module this server is missing. A subject by the catalog's `installed`; the `rvc`
 * environment by the job types the server says it serves (the separator's own verb is `denoise`).
 */
export function missingOf(module: CrucibleModule, catalog: readonly CatalogRow[], jobTypes: readonly string[]): string[] {
  const missing: string[] = [];
  for (const subject of module.subjects) {
    if (!catalog.some((row) => row.kind === subject.kind && row.id === subject.id && row.installed)) missing.push(`${subject.kind} ${subject.id}`);
  }
  for (const entry of module.job_types) {
    const serves = entry.type === 'rvc' ? ['rvc', 'denoise'] : [entry.type];
    if (!serves.some((type) => jobTypes.includes(type))) missing.push(`the ${entry.type} environment`);
  }
  return missing;
}

const POLL_MS = 3000;
/** How often a server whose card is held is asked again for the separator. */
const BUSY_RETRY_MS = 2 * 60_000;

/**
 * One ask per server per run of B-Sides: on connecting (a server set up or switched to) and on
 * a start. Never throws: what happened is the view's sentence, and nothing B-Sides does waits on
 * it (a song that needs the separator would install it itself, 409 installing).
 */
export class ServerNeeds {
  private readonly views = new Map<string, ServerNeedsView>();

  constructor(
    private readonly changed: (view: ServerNeedsView) => void = () => undefined,
    private readonly pollMs = POLL_MS,
    private readonly busyRetryMs = BUSY_RETRY_MS,
  ) {}

  of(server: string): ServerNeedsView | null {
    return this.views.get(server) ?? null;
  }

  /**
   * Ask `server` once; a second call while one ran (or after it) does nothing. `enable` turns
   * the denoise job on in the server's settings (PUT /v1/settings/jobs/denoise): a module task
   * installs the environment and the model but leaves the job off (crucible-pc-1, 2026-10-11).
   */
  ensure(server: string, client: CrucibleClient, enable: () => Promise<void> = async () => undefined): Promise<void> {
    if (this.views.has(server)) return Promise.resolve();
    this.set({ server, state: 'checking', sentence: `Checking whether ${server} has the vocal separator…`, task: null });
    return this.run(server, client, enable).catch((error: unknown) => {
      const said = error instanceof CrucibleRefused ? `${error.code}: ${error.serverMessage}` : error instanceof Error ? error.message : String(error);
      this.set({ server, state: 'failed', sentence: `B-Sides could not ask ${server} for the vocal separator (${said}). It asks again the next time B-Sides starts.`, task: null });
      // Asked again on the next start, not now: a server that refused once refuses a loop too.
    });
  }

  /**
   * Post the module, and while the card is held (`server_busy`: an install rewrites the server's
   * config, so Crucible refuses one while anything holds the card; Victoria's laptop, 2026-10-11,
   * with her albums rendering) ask again every `busyRetryMs` until it is taken. Crucible is to make
   * the task wait its own turn (crucible-pc-1); this is the stand-in until it does.
   */
  private async submitWhenFree(server: string, client: CrucibleClient, module: CrucibleModule, missing: readonly string[]): Promise<string> {
    for (;;) {
      try {
        return await client.submitTask({ type: 'module', module });
      } catch (error) {
        if (!(error instanceof CrucibleRefused && error.code === 'server_busy')) throw error;
        this.set({ server, state: 'checking', sentence: `${server} is busy making something; B-Sides asks it for the vocal separator (${missing.join(', ')}) once it is free.`, task: null });
        await new Promise((resolve) => setTimeout(resolve, this.busyRetryMs));
      }
    }
  }

  private set(view: ServerNeedsView): void {
    this.views.set(view.server, view);
    this.changed(view);
  }

  private async run(server: string, client: CrucibleClient, enable: () => Promise<void>): Promise<void> {
    const info = await client.info();
    const whole = moduleForBackend(info.host.backend);
    if (whole.subjects.length === 0 && whole.job_types.length === 0) {
      this.set({ server, state: 'not-here', sentence: `${server} runs Crucible's ${info.host.backend} engine, which has no vocal separator; everything else works.`, task: null });
      return;
    }
    const catalog = await client.catalog();
    const module = knownTo(whole, catalog, (line) => console.log(`${line} (${server})`));
    const missing = missingOf(module, catalog, info.jobTypes);
    if (missing.length === 0) {
      if (!info.jobTypes.includes('denoise')) await enable();
      this.set({ server, state: 'ready', sentence: `${server} has the vocal separator.`, task: null });
      return;
    }
    let task: string;
    try {
      task = await this.submitWhenFree(server, client, module, missing);
    } catch (error) {
      // A refusal is said as the server said it (Victoria's laptop, 2026-10-11: a 409 read as "busy
      // installing something else" while nothing was installing, and the real reason was lost).
      if (error instanceof CrucibleRefused) {
        console.log(`[needs] ${server} refused the vocal separator's install: ${error.code} (${error.status}): ${error.serverMessage}`);
        this.set({ server, state: 'failed', sentence: `${server} would not install the vocal separator (${error.code}: ${error.serverMessage}). B-Sides asks again the next time it starts.`, task: null });
        return;
      }
      throw error;
    }
    this.set({ server, state: 'installing', sentence: `${server} is installing what B-Sides needs (${missing.join(', ')}). It keeps going if you close this.`, task });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      const status = await client.task(task);
      if (status.state === 'running') continue;
      if (status.state === 'done') {
        // 2.0.5 turns on what it brings; an older server leaves denoise off, and B-Sides turns it on.
        await enable().catch((err: unknown) => console.log(`[needs] ${server}: ${err instanceof Error ? err.message : String(err)}`));
        // What this card cannot hold is skipped, not installed unusable (2.0.5): said, not hidden.
        const unmet = (status.unmet ?? []).map((need) => need.reason);
        if (unmet.length > 0) console.log(`[needs] ${server} skipped what its card cannot hold: ${unmet.join('; ')}`);
        this.set({
          server, state: 'ready', task,
          sentence: unmet.length === 0 ? `${server} has what B-Sides needs.` : `${server} has what B-Sides needs that its card can hold; not: ${unmet.join('; ')}.`,
        });
      } else {
        const why = status.error?.message ?? status.state;
        this.set({ server, state: 'failed', sentence: `${server} did not install the vocal separator: ${why}. B-Sides asks again the next time it starts.`, task });
      }
      return;
    }
  }
}
