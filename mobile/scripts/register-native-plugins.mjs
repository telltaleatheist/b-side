#!/usr/bin/env node
/**
 * Keep the app's own native plugins registered after `cap sync`.
 *
 * Capacitor builds `packageClassList` in capacitor.config.json from installed npm
 * plugins only, so every sync rewrites it without the plugins compiled into the
 * app itself (ios/App/CapApp-SPM/Sources). This puts their @objc class names
 * back. Idempotent; `npm run sync` runs it. (Bookshelf's mobile app does the same.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, '../ios/App/App/capacitor.config.json');
const CLASSES = ['NativeQueuePlugin', 'NativeFilePlugin'];

const json = JSON.parse(readFileSync(configPath, 'utf8'));
if (!Array.isArray(json.packageClassList)) json.packageClassList = [];
let changed = false;
for (const name of CLASSES) {
  if (!json.packageClassList.includes(name)) {
    json.packageClassList.push(name);
    changed = true;
    console.log(`[register-native-plugins] registered ${name}`);
  }
}
if (changed) writeFileSync(configPath, `${JSON.stringify(json, null, '\t')}\n`);
