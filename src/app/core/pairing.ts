import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * Pairing a phone by QR code (Owen, 2026-10-11: "make it so we can pair to
 * multiple b sides desktop apps at once ... itll just list them as available
 * libraries"). The desktop's Settings shows a code holding a `bsides://pair`
 * link; the iPhone's camera opens B-Sides with it (the `bsides` URL scheme in
 * Info.plist), and the app connects to that computer, or, when it already has
 * one, lists it as another library.
 */
export const PAIR_SCHEME = 'bsides:';

/** A computer, as its pairing code carries it. */
export interface PairTarget {
  /** Its hub address, with `/#key=` when it requires the key. */
  readonly link: string;
  /** Its computer's name, so it is found again when its address moves. */
  readonly hostname: string | null;
}

/** The link a desktop's pairing code holds: `bsides://pair?link=<hub link>&host=<computer name>`. */
export function pairLink(target: PairTarget): string {
  const query = new URLSearchParams({ link: target.link });
  if (target.hostname) query.set('host', target.hostname);
  return `bsides://pair?${query.toString()}`;
}

/** What a scanned link pairs with, or null when it is not a pairing link. */
export function readPairLink(text: string): PairTarget | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== PAIR_SCHEME || (url.hostname !== 'pair' && !url.pathname.replace(/^\/+/, '').startsWith('pair'))) return null;
  const link = url.searchParams.get('link');
  if (!link || !/^https?:\/\//i.test(link)) return null;
  return { link, hostname: url.searchParams.get('host') || null };
}

/** Capacitor's App plugin (@capacitor/app, in the iOS project): the link the app was opened with. */
interface AppPlugin {
  getLaunchUrl(): Promise<{ url: string } | undefined>;
  addListener(event: 'appUrlOpen', listener: (event: { url: string }) => void): Promise<PluginListenerHandle>;
}

const App = registerPlugin<AppPlugin>('App');

/** Hear every `bsides://` link the phone opens the app with: the one it launched with, then each later one. */
export function hearPairLinks(heard: (link: string) => void): void {
  void App.getLaunchUrl().then((launch) => {
    if (launch?.url) heard(launch.url);
  }).catch(() => undefined);
  void App.addListener('appUrlOpen', (event) => heard(event.url)).catch(() => undefined);
}
