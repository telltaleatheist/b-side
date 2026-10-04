/**
 * api — `window.bside`, what only the desktop window has.
 *
 * Everything B-Side does goes through the hub's HTTP API, from every client,
 * the desktop window included. The bridge is left with what a browser tab or a
 * phone cannot do: know where the hub is without being told, and use this
 * computer's own dialogs and folders.
 */
import type { HubSettingsView, Outcome } from './types';

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
}
