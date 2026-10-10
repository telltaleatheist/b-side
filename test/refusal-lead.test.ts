import { expect, test } from 'bun:test';

import { leadOf } from '../src/app/components/refusal/refusal.component';

test('the cause leads; the engine log after it is the rest', () => {
  const { lead, rest } = leadOf('vLLM ran out of memory loading qwen3.8-27b-4bit. The last 40 lines of its log:\nline 1\nline 2');
  expect(lead).toBe('vLLM ran out of memory loading qwen3.8-27b-4bit.');
  expect(rest).toBe('The last 40 lines of its log:\nline 1\nline 2');
});

test('one sentence is all lead', () => {
  expect(leadOf('No tag model fits this server.')).toEqual({ lead: 'No tag model fits this server.', rest: '' });
});

test('a first line with no full stop is the lead whole', () => {
  expect(leadOf('engine exited with code 1\ntraceback...')).toEqual({ lead: 'engine exited with code 1', rest: 'traceback...' });
});

test('a version number does not end the sentence', () => {
  expect(leadOf('Crucible 1.0.124 refused it. More here.').lead).toBe('Crucible 1.0.124 refused it.');
});
