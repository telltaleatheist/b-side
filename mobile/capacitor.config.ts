import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.owenmorgan.bside',
  appName: 'B-Sides',
  // `ng build --configuration mobile` (angular.json) builds here.
  webDir: '../dist/mobile/browser',
  ios: {
    // A B-Sides hub speaks plain HTTP on the home network (or a tailnet); Info.plist
    // allows it (NSAllowsArbitraryLoads) and says why the app looks on the local
    // network (NSLocalNetworkUsageDescription).
    limitsNavigationsToAppBoundDomains: false,
    // DO NOT set `scheme`: HubService's `isNative` is `location.protocol === 'capacitor:'`.
    // Bookshelf learned that a scheme override silently breaks that witness.
  },
};

export default config;
