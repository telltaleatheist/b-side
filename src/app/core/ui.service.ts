import { Injectable, signal } from '@angular/core';

/** Shell state that is no route: whether the phone's full-screen Now Playing is open, and the first-run welcome. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly nowPlayingOpen = signal(false);
  /**
   * The desktop's welcome (Owen, 2026-10-11): shown on its own while no Crucible server is set
   * up, until it is closed; closed, it is offered again on the next start, and opened again by
   * any "Set up Crucible" (app-needs-crucible).
   */
  readonly welcomeClosed = signal(false);
}
