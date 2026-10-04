import { Routes } from '@angular/router';

import { ListenPageComponent } from './pages/listen/listen-page.component';
import { PlaylistsPageComponent } from './pages/playlists/playlists-page.component';
import { SettingsPageComponent } from './pages/settings/settings-page.component';
import { StudioPageComponent } from './pages/studio/studio-page.component';

export const routes: Routes = [
  { path: '', component: ListenPageComponent },
  { path: 'make', component: StudioPageComponent },
  { path: 'library', component: PlaylistsPageComponent },
  { path: 'library/:id', component: PlaylistsPageComponent },
  { path: 'settings', component: SettingsPageComponent },
  // The old addresses, for a browser bookmark.
  { path: 'playlists', redirectTo: 'library' },
  { path: '**', redirectTo: '' },
];
