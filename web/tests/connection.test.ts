import test from 'node:test';
import assert from 'node:assert/strict';
import { isSyncUnverified, connectionView } from '../src/lib/connection.ts';
import type { Status } from '../src/lib/api.ts';

const now = Date.parse('2026-10-23T10:00:00.000Z');
const connected: Status = {
  connected: true, qr: null, me: null, syncing: false, connectionState: 'connected',
  lastConnectedAt: '2026-10-23T09:59:00.000Z',
  syncEvidence: {
    available: true, lastIngestedAt: '2026-10-23T09:59:30.000Z',
    lastSavedMessageAt: '2026-10-23T09:59:30.000Z', newMessageAfterConnect: true,
    pendingInMemory: 0,
    writeHealth: { lastWriteSuccessAt: null, lastWriteFailureAt: null, consecutiveWriteFailures: 0 },
  },
};

test('connected state warns immediately when a message is pending after write failure', () => {
  assert.equal(isSyncUnverified(connected, now), false);
  const stalled: Status = {
    ...connected,
    syncEvidence: { ...connected.syncEvidence!, pendingInMemory: 1,
      writeHealth: { lastWriteSuccessAt: null, lastWriteFailureAt: now.toString(), consecutiveWriteFailures: 1 } },
  };
  assert.equal(isSyncUnverified(stalled, now), true);
  assert.equal(isSyncUnverified({ ...stalled, syncing: true }, now), true);
  assert.equal(connectionView(stalled).state, 'sync_unverified');
});

test('connected state warns when database evidence is unavailable', () => {
  assert.equal(isSyncUnverified({ ...connected, syncEvidence: { ...connected.syncEvidence!, available: false } }, now), true);
});
