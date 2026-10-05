/**
 * crucible-install-wire — what main tells the desktop window while Crucible is
 * installed on this computer, and what it says about the Crucible already here.
 *
 * Ported from Foundry (app/shared/crucible-install-wire.ts and the install-plan
 * shapes of app/shared/slots.ts), which follows crucible
 * `docs/PHASE19-AUTOMATIC-WSL.md`: §2.2 the outcome file, §2.6 the install door
 * that can be WATCHED as well as driven, §3.1 the progress list. The rule that
 * shapes all of it is PHASE19 §0's — *"nobody is ever shown a command"* — so
 * there is no command and no token anywhere in these shapes: there is a list of
 * rows that fills in, and at the end of it one sentence.
 *
 * Desktop-only. These cross the preload bridge (shared/api.ts), never the hub's
 * HTTP API: installing software on this computer is not something a phone or a
 * browser tab may ask for.
 *
 * The event NAMES are `@crucible/bootstrap`'s (`HOST_EVENT_KINDS`: step,
 * progress, state, line, done, failed); this file only reads them into
 * camelCase, because everything that crosses the bridge is camelCase.
 *
 * The rows are a REDUCER, not a log: a first install is tens of minutes of
 * downloads, and "row three of five" answers "is it stuck?" where the
 * installer's last line does not. {@link applyInstallEvent} is pure, so a test
 * drives it with a scripted stream.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The plan — the rows this computer's install will have
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The platforms the sequence differs by, and a word for the rest. Not
 * `NodeJS.Platform`: the renderer compiles this file and has no node types.
 */
export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

/** Which named row an event is about. The ids are matched, never the labels. */
export type CrucibleInstallRowId = 'install' | 'windows-engine' | 'linux-engine' | 'job-types' | 'models';

export interface CrucibleInstallStep {
  readonly id: CrucibleInstallRowId;
  readonly title: string;
  readonly detail: string;
}

/** Everything the "Install Crucible on this computer" door draws before it runs. */
export interface CrucibleInstallPlan {
  readonly platform: InstallPlatform;
  /** The hardware probe's own sentence about this computer (electron/system-probe.ts). */
  readonly machine: string;
  /** The rows, in order. Empty on a platform Crucible does not support. */
  readonly steps: readonly CrucibleInstallStep[];
  /** Whether this computer can be installed on at all. */
  readonly supported: boolean;
  /** Why not, when it cannot; '' when it can. */
  readonly unsupportedWhy: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The Crucible already on this computer
// ─────────────────────────────────────────────────────────────────────────────

/** The installation faults: the only states that earn the word "repair". The SDK's own words. */
export type CrucibleFault = 'wrong_service' | 'unauthorized' | 'broken';

/**
 * What the local Crucible is doing, in the distinctions B-Sides acts on
 * (Foundry's electron/crucible-start.ts `CrucibleRunState`, which split the
 * SDK's eight states this way after a three-second `/v1/info` timeout drew a
 * "repair your installation" card over a healthy engine):
 *
 *   absent       nothing installed — offer the install;
 *   stopped      installed, its service stopped — offer to start it;
 *   unreachable  installed, nothing answering — starting it is the repair;
 *   unhealthy    it answered its ping and not the rest — nothing to start, nothing to repair;
 *   running      serving;
 *   problem      the installation itself is at fault (one of three faults).
 */
export type LocalCrucibleState =
  | { readonly kind: 'absent'; readonly why: string }
  | { readonly kind: 'stopped'; readonly why: string }
  | { readonly kind: 'unreachable'; readonly why: string }
  | { readonly kind: 'unhealthy'; readonly why: string }
  | { readonly kind: 'running'; readonly why: string }
  /** `why` is Crucible's own detail; `what` is what a person does about this fault. */
  | { readonly kind: 'problem'; readonly fault: CrucibleFault; readonly why: string; readonly what: string };

/**
 * The connection Crucible published on this computer (its pairing file), as
 * the window may see it: name and address, never the token.
 */
export interface PublishedCrucible {
  readonly name: string;
  readonly url: string;
  /** The B-Sides server that points at this address, or null when none does yet. */
  readonly registeredAs: string | null;
  /** Whether that server is the one B-Sides uses. */
  readonly active: boolean;
}

export interface LocalCrucibleView {
  readonly platform: InstallPlatform;
  readonly state: LocalCrucibleState;
  /** The pairing file's server, or null when there is none. */
  readonly published: PublishedCrucible | null;
  /** A pairing file that exists and cannot be read: the reader's sentence. Null otherwise. */
  readonly publishedRefusal: string | null;
}

/** What "Start Crucible" answered: whether it is serving now, and in Crucible's own words. */
export interface CrucibleStartResult {
  readonly started: boolean;
  readonly detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The outcome — §2.2, the one owner of "what happened to the engine move here"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five words of `%LOCALAPPDATA%\Crucible\wsl-outcome.json` (Windows only).
 * `declined` is `[orchestrator] wsl = "never"`: a machine somebody kept native on
 * purpose, which is read so it is not offered a Try again.
 */
export const CRUCIBLE_INSTALL_OUTCOME_STATES = ['done', 'reboot-pending', 'cannot', 'failed', 'declined'] as const;

export type CrucibleInstallOutcomeState = (typeof CRUCIBLE_INSTALL_OUTCOME_STATES)[number];

export interface CrucibleInstallOutcome {
  readonly state: CrucibleInstallOutcomeState;
  /** A state-table code or a task failure code; null on `done` and `declined`. */
  readonly code: string | null;
  /** The sentence, verbatim, and the only thing a person is shown about a refusal. */
  readonly sentence: string | null;
  readonly at: string;
  readonly release: string | null;
  /** A `failed` is retried once by Crucible's tray; the count lives in the file. */
  readonly attempts: number;
}

/** `GET /install` on Crucible's Windows tray (§2.6). Off Windows: never running, no outcome. */
export interface CrucibleInstallStatus {
  readonly running: boolean;
  readonly outcome: CrucibleInstallOutcome | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The events
// ─────────────────────────────────────────────────────────────────────────────

/** `state`'s action kind, as the SDK's `WslAction` spells it. */
export type CrucibleInstallAction = 'run' | 'run-elevated' | 'instruct' | 'link';

export type CrucibleInstallEvent =
  /** A row began. `jobType` is set only on the `job-types` row, whose children are the job types. */
  | { readonly event: 'step'; readonly row: CrucibleInstallRowId; readonly jobType: string | null }
  /** Bytes, for the downloads that have a total. pip has none and sends `line`. */
  | { readonly event: 'progress'; readonly bytesDone: number; readonly bytesTotal: number | null; readonly file: string }
  /** The WSL state table's answer for this machine, mid-move. */
  | { readonly event: 'state'; readonly code: string; readonly sentence: string; readonly action: CrucibleInstallAction }
  /** One line a step printed, under the row it belongs to. */
  | { readonly event: 'line'; readonly text: string; readonly stream: 'stdout' | 'stderr' }
  /**
   * The run finished. `backend` is what is serving now, MEASURED from the
   * engine that answered, so the last sentence can say which engine; null when
   * nothing measured it.
   */
  | { readonly event: 'done'; readonly backend: string | null }
  /** The run stopped. */
  | { readonly event: 'failed'; readonly code: string; readonly message: string };

// ─────────────────────────────────────────────────────────────────────────────
// The rows, and the reducer that fills them in
// ─────────────────────────────────────────────────────────────────────────────

export type CrucibleInstallRowState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

/** One job type under the `job-types` row. */
export interface CrucibleInstallChildRow {
  readonly jobType: string;
  readonly state: CrucibleInstallRowState;
  /** pip's last line for this job type (pip has no byte total, so no bar). */
  readonly detail: string | null;
}

export interface CrucibleInstallRow {
  readonly id: CrucibleInstallRowId;
  readonly label: string;
  readonly state: CrucibleInstallRowState;
  /** The last thing this row said: a printed line, or a state sentence. */
  readonly detail: string | null;
  /** Bytes, when the step carries them; both null on a step that cannot count. */
  readonly bytesDone: number | null;
  readonly bytesTotal: number | null;
  readonly children: readonly CrucibleInstallChildRow[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableRow = Mutable<Omit<CrucibleInstallRow, 'children'>> & { children: Mutable<CrucibleInstallChildRow>[] };

/** The skeleton, from the plan's steps. Every row `waiting`. */
export function initialInstallRows(steps: readonly CrucibleInstallStep[]): CrucibleInstallRow[] {
  return steps.map((step) => ({
    id: step.id,
    label: step.title,
    state: 'waiting',
    detail: null,
    bytesDone: null,
    bytesTotal: null,
    children: [],
  }));
}

/**
 * One event, applied. Pure: it returns new rows and changes nothing.
 *
 *   1. A `step` marks its row `running` and every earlier running row `done`.
 *      The stream is ordered, so a later row starting is the only proof an
 *      earlier one finished; the door sends no per-row "finished".
 *   2. `progress`, `line` and `state` land on whichever row is running: they
 *      carry no row of their own on the wire.
 *   3. `done` and `failed` are terminal. `done` finishes what was running and
 *      SKIPS what never started (a Mac has no Windows engine to start; a machine
 *      that declined the move never sets up the Linux one), and the window draws
 *      no skipped row — a grey row under "Done" forever would be the screen
 *      claiming something it does not know. `failed` fails what was running and
 *      skips the rest, because a row after a failure did not run either.
 *
 * A `step` for a row this skeleton does not have (a Windows row arriving on a
 * Mac) is dropped, not appended: the skeleton is the platform's.
 */
export function applyInstallEvent(
  rows: readonly CrucibleInstallRow[],
  event: CrucibleInstallEvent,
): CrucibleInstallRow[] {
  const copy: MutableRow[] = rows.map((row) => ({ ...row, children: row.children.map((child) => ({ ...child })) }));
  const running = copy.find((row) => row.state === 'running');

  switch (event.event) {
    case 'step': {
      const at = copy.findIndex((row) => row.id === event.row);
      const began = copy[at];
      if (began === undefined) return copy;
      for (const earlier of copy.slice(0, at)) {
        if (earlier.state === 'running') earlier.state = 'done';
      }
      began.state = 'running';
      if (event.jobType !== null) {
        for (const child of began.children) {
          if (child.state === 'running') child.state = 'done';
        }
        const child = began.children.find((it) => it.jobType === event.jobType);
        if (child === undefined) began.children.push({ jobType: event.jobType, state: 'running', detail: null });
        else child.state = 'running';
      }
      return copy;
    }
    case 'progress':
      if (running === undefined) return copy;
      running.bytesDone = event.bytesDone;
      running.bytesTotal = event.bytesTotal;
      running.detail = event.file;
      return copy;
    case 'line': {
      if (running === undefined) return copy;
      const child = running.children.find((it) => it.state === 'running');
      if (child === undefined) running.detail = event.text;
      else child.detail = event.text;
      return copy;
    }
    case 'state':
      if (running === undefined) return copy;
      running.detail = event.sentence;
      return copy;
    case 'done':
      for (const row of copy) {
        if (row.state === 'running') row.state = 'done';
        else if (row.state === 'waiting') row.state = 'skipped';
        for (const child of row.children) {
          if (child.state === 'running') child.state = 'done';
          else if (child.state === 'waiting') child.state = 'skipped';
        }
      }
      return copy;
    case 'failed':
      for (const row of copy) {
        if (row.state === 'running') {
          row.state = 'failed';
          row.detail = event.message;
        } else if (row.state === 'waiting') {
          row.state = 'skipped';
        }
        for (const child of row.children) {
          if (child.state === 'running') child.state = 'failed';
          else if (child.state === 'waiting') child.state = 'skipped';
        }
      }
      return copy;
  }
}
