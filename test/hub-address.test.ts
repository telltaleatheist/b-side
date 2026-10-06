import { expect, test } from 'bun:test';

import { parseHubLink } from '../src/app/core/hub.service';

test('a bare address connects, as with Ollama; no port means 7300', () => {
  expect(parseHubLink('192.168.68.86')).toEqual({ url: 'http://192.168.68.86:7300', key: '' });
  expect(parseHubLink(' owens-mac-studio.local ')).toEqual({ url: 'http://owens-mac-studio.local:7300', key: '' });
  expect(parseHubLink('192.168.68.86:7400')).toEqual({ url: 'http://192.168.68.86:7400', key: '' });
  expect(parseHubLink('http://mac:7300/')).toEqual({ url: 'http://mac:7300', key: '' });
});

test('a link with its key still works, and https keeps its own port', () => {
  expect(parseHubLink('http://10.0.0.2:7300/#key=abc%2Bd')).toEqual({ url: 'http://10.0.0.2:7300', key: 'abc+d' });
  expect(parseHubLink('https://bsides.example.com')).toEqual({ url: 'https://bsides.example.com', key: '' });
});

test('not an address', () => {
  expect(parseHubLink('')).toBeNull();
  expect(parseHubLink('ftp://x')).toBeNull();
  expect(parseHubLink('not an address')).toBeNull();
});
