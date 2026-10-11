import { describe, expect, test } from 'bun:test';

import { pairLink, readPairLink } from '../src/app/core/pairing';

describe('pairing codes', () => {
  test('a pairing link carries the hub link and the computer name back out', () => {
    const link = pairLink({ link: 'http://192.168.1.20:7300', hostname: 'studio.local' });
    expect(link.startsWith('bsides://pair?')).toBe(true);
    expect(readPairLink(link)).toEqual({ link: 'http://192.168.1.20:7300', hostname: 'studio.local' });
  });

  test('a link with the key keeps it', () => {
    const hub = 'http://192.168.1.20:7300/#key=abc123';
    expect(readPairLink(pairLink({ link: hub, hostname: null }))).toEqual({ link: hub, hostname: null });
  });

  test('anything else is not a pairing code', () => {
    expect(readPairLink('https://example.com/pair?link=http://x')).toBeNull();
    expect(readPairLink('bsides://pair')).toBeNull();
    expect(readPairLink('bsides://pair?link=javascript:alert(1)')).toBeNull();
    expect(readPairLink('not a url')).toBeNull();
  });
});
