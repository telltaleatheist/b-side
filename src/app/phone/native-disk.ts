import { registerPlugin } from '@capacitor/core';

import type { Disk } from '@shared/core/disk';
import type { Vault } from '@shared/core/servers';

/** mobile/ios/.../NativeDiskPlugin.swift: paths are relative to Documents/bside. */
interface NativeDiskPlugin {
  root(): Promise<{ url: string }>;
  mkdir(options: { path: string }): Promise<void>;
  list(options: { path: string }): Promise<{ names: string[] | null }>;
  readText(options: { path: string }): Promise<{ text: string | null }>;
  writeText(options: { path: string; text: string }): Promise<void>;
  exists(options: { path: string }): Promise<{ exists: boolean }>;
  move(options: { from: string; to: string }): Promise<void>;
  copy(options: { from: string; to: string }): Promise<void>;
  remove(options: { path: string }): Promise<void>;
  /** Straight to disk with `headers`; rejects with code `unreachable` when the network failed. */
  download(options: { url: string; path: string; headers: Record<string, string> }): Promise<{ bytes: number }>;
}

/** mobile/ios/.../NativeKeychainPlugin.swift. */
interface NativeKeychainPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string | null }): Promise<void>;
}

export const NativeDisk = registerPlugin<NativeDiskPlugin>('NativeDisk');
const NativeKeychain = registerPlugin<NativeKeychainPlugin>('NativeKeychain');

/** The shared core's `Disk` over the app's own folder. */
export const nativeDisk: Disk = {
  mkdir: (path) => NativeDisk.mkdir({ path }),
  list: async (path) => (await NativeDisk.list({ path })).names,
  readText: async (path) => (await NativeDisk.readText({ path })).text,
  writeText: (path, text) => NativeDisk.writeText({ path, text }),
  exists: async (path) => (await NativeDisk.exists({ path })).exists,
  move: (from, to) => NativeDisk.move({ from, to }),
  copy: (from, to) => NativeDisk.copy({ from, to }),
  remove: (path) => NativeDisk.remove({ path }),
};

/** The server list, tokens and all, as one Keychain item. */
export function keychainVault(key: string): Vault {
  return {
    where: `the phone's Keychain (${key})`,
    read: async () => (await NativeKeychain.get({ key })).value,
    write: (text) => NativeKeychain.set({ key, value: text }),
  };
}
