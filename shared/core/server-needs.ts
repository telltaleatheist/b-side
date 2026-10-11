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

import type { ServerNeedsView } from '../types';

/** The separator B-Sides asks for, by its catalog id. */
export const SEPARATOR_MODEL = 'vocals-roformer';

interface ModuleRow {
  readonly backends?: readonly string[];
}

/** What `modules/b-sides.toml` generates (see the header), as Crucible 2.0.4 generated it. */
export const B_SIDES_MODULE = {
  name: 'b-sides',
  version: '2.0.4+085acd33d0c6',
  job_types: [{ type: 'rvc', backends: ['cuda-linux', 'mlx-darwin'] }],
  needs: [],
  subjects: [{ kind: 'denoise', id: SEPARATOR_MODEL, backends: ['cuda-linux', 'mlx-darwin'] }],
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

/**
 * One ask per server per run of B-Sides: on connecting (a server set up or switched to) and on
 * a start. Never throws: what happened is the view's sentence, and nothing B-Sides does waits on
 * it (a song that needs the separator would install it itself, 409 installing).
 */
export class ServerNeeds {
  private readonly views = new Map<string, ServerNeedsView>();

  constructor(private readonly changed: (view: ServerNeedsView) => void = () => undefined, private readonly pollMs = POLL_MS) {}

  of(server: string): ServerNeedsView | null {
    return this.views.get(server) ?? null;
  }

  /** Ask `server` once; a second call while one ran (or after it) does nothing. */
  ensure(server: string, client: CrucibleClient): Promise<void> {
    if (this.views.has(server)) return Promise.resolve();
    this.set({ server, state: 'checking', sentence: `Checking whether ${server} has the vocal separator…`, task: null });
    return this.run(server, client).catch((error: unknown) => {
      const said = error instanceof CrucibleRefused ? `${error.code}: ${error.serverMessage}` : error instanceof Error ? error.message : String(error);
      this.set({ server, state: 'failed', sentence: `B-Sides could not ask ${server} for the vocal separator (${said}). It asks again the next time B-Sides starts.`, task: null });
      // Asked again on the next start, not now: a server that refused once refuses a loop too.
    });
  }

  private set(view: ServerNeedsView): void {
    this.views.set(view.server, view);
    this.changed(view);
  }

  private async run(server: string, client: CrucibleClient): Promise<void> {
    const info = await client.info();
    const module = moduleForBackend(info.host.backend);
    if (module.subjects.length === 0 && module.job_types.length === 0) {
      this.set({ server, state: 'not-here', sentence: `${server} runs Crucible's ${info.host.backend} engine, which has no vocal separator; everything else works.`, task: null });
      return;
    }
    const missing = missingOf(module, await client.catalog(), info.jobTypes);
    if (missing.length === 0) {
      this.set({ server, state: 'ready', sentence: `${server} has the vocal separator.`, task: null });
      return;
    }
    let task: string;
    try {
      task = await client.submitTask({ type: 'module', module });
    } catch (error) {
      // One task at a time on a server: another app's (or an install-on-submit) is running.
      if (error instanceof CrucibleRefused && error.status === 409) {
        this.set({ server, state: 'failed', sentence: `${server} is busy installing something else, so B-Sides asks for the vocal separator the next time it starts.`, task: null });
        return;
      }
      throw error;
    }
    this.set({ server, state: 'installing', sentence: `${server} is installing the vocal separator (${missing.join(', ')}). It keeps going if you close this.`, task });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      const status = await client.task(task);
      if (status.state === 'running') continue;
      if (status.state === 'done') {
        this.set({ server, state: 'ready', sentence: `${server} has the vocal separator.`, task });
      } else {
        const why = status.error?.message ?? status.state;
        this.set({ server, state: 'failed', sentence: `${server} did not install the vocal separator: ${why}. B-Sides asks again the next time it starts.`, task });
      }
      return;
    }
  }
}
