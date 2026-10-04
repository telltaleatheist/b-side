import { Routes } from '@angular/router';

import { PlaylistsPageComponent } from './pages/playlists/playlists-page.component';
import { SettingsPageComponent } from './pages/settings/settings-page.component';
import { StudioPageComponent } from './pages/studio/studio-page.component';

export const routes: Routes = [
  { path: '', component: StudioPageComponent },
  { path: 'playlists', component: PlaylistsPageComponent },
  { path: 'settings', component: SettingsPageComponent },
  { path: '**', redirectTo: '' },
];
