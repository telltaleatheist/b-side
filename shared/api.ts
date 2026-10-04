/**
 * api — `window.bside`, what only the desktop window has.
 *
 * Everything B-Side does goes through the hub's HTTP API, from every client,
 * the desktop window included. The bridge is left with what a browser tab or a
 * phone cannot do: know where the hub is without being told, use this
 * computer's own dialogs and folders, and install Crucible on this computer.
 */
import type {
  CrucibleInstallEvent,
  CrucibleInstallPlan,
  CrucibleInstallStatus,
  CrucibleStartResult,
  LocalCrucibleView,
} from './crucible-install-wire';
import type { HubSettingsView, Outcome, ServerView } from './types';
import type {
  CrucibleUninstallAvailability,
  CrucibleUninstallFlags,
  CrucibleUninstallPlan,
  CrucibleUninstallRun,
} from './uninstall-wire';

/**
 * The Crucible on THIS computer: install it, start it, use it, remove it.
 *
 * On the bridge and never on the hub's HTTP API, on purpose: a phone or a
 * browser tab must not be able to install (or remove) software on the computer
 * B-Side runs on. Every act that changes B-Side's server list also reaches every
 * other device through the hub's `servers` event.
 */
export interface CrucibleSetupBridge {
  /** What this computer has: a Crucible or not, running or not, and whether B-Side uses it. Reads only. */
  local(): Promise<Outcome<LocalCrucibleView>>;
  /** The rows an install would have here, and a sentence about this computer. Reads only. */
  installPlan(): Promise<Outcome<CrucibleInstallPlan>>;
  /** Is an install running here, and how did the last engine move end? Also joins a running one's events. */
  installStatus(): Promise<Outcome<CrucibleInstallStatus>>;
  /** Install Crucible here, start it, and make it the server B-Side uses. Progress arrives on `onInstallEvent`. */
  install(): Promise<Outcome<null>>;
  /** Try the engine move again (Windows, after `cannot` or `failed`). */
  installRetry(): Promise<Outcome<null>>;
  /** Hear the install's progress. Answers the unsubscribe. */
  onInstallEvent(listener: (event: CrucibleInstallEvent) => void): () => void;
  /** Hear that a move Crucible's tray ran by itself has ended (ask `installStatus` again). Answers the unsubscribe. */
  onInstallSettled(listener: () => void): () => void;
  /** Start the Crucible installed here (it stays running after B-Side closes), then use it. */
  start(): Promise<Outcome<CrucibleStartResult>>;
  /** Use the Crucible this computer published, and make it the server B-Side uses. */
  useLocal(): Promise<Outcome<ServerView[]>>;
  /** Restart Windows, when Crucible's engine move is waiting for one. Only ever on a press. */
  restartWindows(): Promise<Outcome<null>>;
  uninstallAvailability(): Promise<Outcome<CrucibleUninstallAvailability>>;
  uninstallDryRun(flags: CrucibleUninstallFlags): Promise<Outcome<CrucibleUninstallPlan>>;
  uninstall(flags: CrucibleUninstallFlags): Promise<Outcome<CrucibleUninstallRun>>;
}

export interface DesktopBridge {
  /** Where this computer reaches the hub, and its key. Read once, at start. */
  readonly hub: { readonly url: string; readonly key: string };

  /** Choose the library folder with a folder dialog. Null when the person cancelled. */
  chooseLibraryDir(): Promise<Outcome<HubSettingsView | null>>;
  resetLibraryDir(): Promise<Outcome<HubSettingsView>>;
  /** Ask where to save a copy of a saved song, then copy it there. Null when the person cancelled. */
  saveCopy(songId: string): Promise<Outcome<string | null>>;
  /** Show a saved song in its folder. */
  reveal(songId: string): Promise<Outcome<null>>;

  readonly crucible: CrucibleSetupBridge;
}
