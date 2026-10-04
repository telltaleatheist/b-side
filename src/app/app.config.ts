import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withHashLocation } from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Hash routing: the same build is served by the hub, by ng serve and by the
    // iOS app's capacitor://localhost, and a hash route needs nothing from any of
    // them. (A hub link's `#key=...` is read and removed by HubService first.)
    provideRouter(routes, withHashLocation()),
  ],
};
