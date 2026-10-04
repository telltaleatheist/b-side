import type { BSideApi } from '@shared/api';

declare global {
  interface Window {
    bside?: BSideApi;
  }
}

/**
 * The bridge, or nothing.
 *
 * Null when the renderer is opened in a plain browser (`ng serve` without
 * Electron): every service then shows an empty app that says why, rather than
 * a white screen of `undefined is not a function`.
 */
export const api: BSideApi | null = typeof window !== 'undefined' && window.bside ? window.bside : null;
