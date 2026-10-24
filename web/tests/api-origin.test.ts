import test from 'node:test';
import assert from 'node:assert/strict';
import { validateApiUrl } from '../src/lib/api.ts';

const PINNED = 'https://api.do-operador.exemplo';

test('new accounts can connect only to the operator-pinned HTTPS origin', () => {
  Object.assign(globalThis, { window: { location: { hostname: 'app.do-operador.exemplo' } } });
  process.env.VITE_SUCO_LEGACY_API_ORIGIN = PINNED;
  assert.equal(validateApiUrl(PINNED + '/'), PINNED);
  for (const value of [
    'https://example.com', PINNED + '.evil.example', PINNED + ':8447',
    PINNED.replace('https', 'http'), 'https://user:secret@api.do-operador.exemplo',
    PINNED + '/api', PINNED + '?token=x', PINNED + '#secret',
  ]) assert.throws(() => validateApiUrl(value), /oficial/);
  delete process.env.VITE_SUCO_LEGACY_API_ORIGIN;
});

test('without a pinned origin nothing is approved (fail closed)', () => {
  Object.assign(globalThis, { window: { location: { hostname: 'app.do-operador.exemplo' } } });
  delete process.env.VITE_SUCO_LEGACY_API_ORIGIN;
  assert.throws(() => validateApiUrl('https://api.do-operador.exemplo'), /oficial/);
  assert.throws(() => validateApiUrl('https://suco-api.gogrowth.me'), /oficial/);
});

test('local dev keeps localhost allowance regardless of the pin', () => {
  Object.assign(globalThis, { window: { location: { hostname: '127.0.0.1' } } });
  process.env.VITE_SUCO_LEGACY_API_ORIGIN = PINNED;
  assert.equal(validateApiUrl('http://127.0.0.1:8377/'), 'http://127.0.0.1:8377');
  delete process.env.VITE_SUCO_LEGACY_API_ORIGIN;
});
