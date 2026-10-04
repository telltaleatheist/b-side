import { Injectable, signal } from '@angular/core';

/** Shell state that is no route: whether the phone's full-screen Now Playing is open. */
@Injectable({ providedIn: 'root' })
export class UiService {
  readonly nowPlayingOpen = signal(false);
}
