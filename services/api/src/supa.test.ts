import test from 'node:test';
import assert from 'node:assert/strict';
import { keyHeaders } from './supa.ts';

test('new sb_secret keys go in apikey only; legacy JWT keys go in both headers', () => {
  const modern = keyHeaders('sb_secret_abc123', { 'Content-Type': 'application/json' });
  assert.equal(modern.apikey, 'sb_secret_abc123');
  assert.equal('Authorization' in modern, false);
  assert.equal(modern['Content-Type'], 'application/json');
  const legacy = keyHeaders('eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(legacy.apikey, 'eyJhbGciOiJIUzI1NiJ9.payload.sig');
  assert.equal(legacy.Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
});
