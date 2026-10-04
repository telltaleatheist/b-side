import { computed, Injectable, signal } from '@angular/core';

import type { ServerView } from '@shared/types';

import { api } from './bside';

/** The servers main knows (never their tokens), and which one is active. */
@Injectable({ providedIn: 'root' })
export class ServersService {
  readonly servers = signal<ServerView[]>([]);
  readonly loaded = signal(false);
  readonly active = computed(() => this.servers().find((server) => server.active) ?? null);

  constructor() {
    if (api === null) return;
    void api.servers.list().then((servers) => {
      this.servers.set(servers);
      this.loaded.set(true);
    });
    api.servers.onChanged((servers) => this.servers.set(servers));
  }
}
