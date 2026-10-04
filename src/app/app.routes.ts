import { Routes } from '@angular/router';

import { SettingsPageComponent } from './pages/settings/settings-page.component';
import { StudioPageComponent } from './pages/studio/studio-page.component';

export const routes: Routes = [
  { path: '', component: StudioPageComponent },
  { path: 'settings', component: SettingsPageComponent },
  { path: '**', redirectTo: '' },
];
