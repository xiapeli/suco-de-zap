import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareLegacyIdentityLock, prepareScanBoundLegacyIdentityLock } from '../src/lib/legacy-identity-preflight.js';
import { legacyIdentityLockFingerprint } from '../src/lib/confidential-auth-state.js';

const JID = '5511999999999@s.whatsapp.net'; // synthetic only
const creds = (id: string, marker: string) => Buffer.from(JSON.stringify({ me: { id }, marker }));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('prior pinned snapshot binds only the same normalized WhatsApp identity', () => {
  const prior = creds(JID, 'snapshot');
  const current = creds('5511999999999:3@s.whatsapp.net', 'rotated-keys');
  const result = prepareLegacyIdentityLock({
    currentCreds: current, trustedSnapshotCreds: prior, pinnedSnapshotSha256: hash(prior),
  });
  assert.equal(result.jid, JID);
  assert.equal(result.fingerprint, legacyIdentityLockFingerprint(result.proof));
  assert.equal(result.proof.digest, scryptSync(JID, Buffer.from(result.proof.salt, 'hex'), 32).toString('hex'));
  assert.equal(JSON.stringify(result.proof).includes(JID), false);
  assert.equal(result.fingerprint.includes('5511'), false);
  assert.throws(() => prepareLegacyIdentityLock({
    currentCreds: current, trustedSnapshotCreds: prior, pinnedSnapshotSha256: '0'.repeat(64),
  }), { code: 'LEGACY_SNAPSHOT_UNTRUSTED' });
  assert.throws(() => prepareLegacyIdentityLock({
    currentCreds: creds('5511888888888@s.whatsapp.net', 'other'),
    trustedSnapshotCreds: prior, pinnedSnapshotSha256: hash(prior),
  }), { code: 'LEGACY_IDENTITY_MISMATCH' });
  assert.throws(() => prepareLegacyIdentityLock({
    currentCreds: Buffer.from('{}'), trustedSnapshotCreds: prior, pinnedSnapshotSha256: hash(prior),
  }), { code: 'LEGACY_AUTH_INVALID' });
  assert.throws(() => prepareScanBoundLegacyIdentityLock({
    currentCreds: current, pinnedCurrentSha256: '0'.repeat(64),
  }), { code: 'LEGACY_SNAPSHOT_UNTRUSTED' });
});

test('offline helper checks without writing, then creates only 0600 lock and returns stable pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'suco-identity-preflight-'));
  try {
    const authDir = join(root, 'auth_state');
    mkdirSync(authDir, { mode: 0o700 });
    const current = join(authDir, 'creds.json');
    const snapshot = join(root, 'trusted-prior-creds.json');
    const priorBytes = creds(JID, 'trusted-prior');
    writeFileSync(current, creds(JID, 'current'), { mode: 0o600 });
    writeFileSync(snapshot, priorBytes, { mode: 0o600 });
    const argv = ['--current', current, '--snapshot', snapshot, '--snapshot-sha256', hash(priorBytes)];
    const run = (mode: string) => spawnSync(process.execPath, ['--import', 'tsx',
      'tools/prepare-legacy-identity-lock.ts', ...argv, mode], { cwd: process.cwd(), encoding: 'utf8' });
    const check = run('--check');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stdout.trim(), 'LEGACY_IDENTITY_MATCH=true');
    assert.throws(() => statSync(`${authDir}.identity-lock.json`), { code: 'ENOENT' });
    const hardlink = join(root, 'same-inode.json');
    linkSync(current, hardlink);
    const linked = spawnSync(process.execPath, ['--import', 'tsx',
      'tools/prepare-legacy-identity-lock.ts', '--current', current, '--snapshot', hardlink,
      '--snapshot-sha256', hash(readFileSync(current)), '--check'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(linked.status, 1);
    assert.equal(linked.stderr.trim(), 'LEGACY_SNAPSHOT_UNTRUSTED');
    const first = run('--write');
    assert.equal(first.status, 0, first.stderr);
    const second = run('--write');
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    assert.match(first.stdout, /^LEGACY_IDENTITY_LOCK_FINGERPRINT=[a-f0-9]{64}\nLEGACY_IDENTITY_BUNDLE_PATH=.+\nLEGACY_IDENTITY_SCAN_REQUIRED=true\n$/);
    const lock = `${authDir}.identity-lock.json`;
    const bundle = `${authDir}.identity-bundle.json`;
    assert.equal(statSync(lock).mode & 0o777, 0o600);
    assert.equal(statSync(bundle).mode & 0o777, 0o600);
    assert.equal(readFileSync(lock, 'utf8').includes(JID), false);
    assert.equal(JSON.parse(readFileSync(bundle, 'utf8')).jid, JID);
    assert.equal(first.stdout.includes(JID), false);
    assert.equal(first.stderr.includes(JID), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopped-volume baseline creates a private bundle only with explicit scan requirement', () => {
  const root = mkdtempSync(join(tmpdir(), 'suco-owner-scan-lock-'));
  try {
    const authDir = join(root, 'auth_state');
    mkdirSync(authDir, { mode: 0o700 });
    const current = join(authDir, 'creds.json');
    const currentBytes = creds(JID, 'current-volume');
    writeFileSync(current, currentBytes, { mode: 0o600 });
    const run = (sha: string, mode: string) => spawnSync(process.execPath, ['--import', 'tsx',
      'tools/prepare-legacy-identity-lock.ts', '--current', current,
      '--current-sha256', sha, '--owner-scan-required', mode],
    { cwd: process.cwd(), encoding: 'utf8' });
    const wrong = run('0'.repeat(64), '--write');
    assert.equal(wrong.status, 1);
    assert.equal(wrong.stderr.trim(), 'LEGACY_SNAPSHOT_UNTRUSTED');
    assert.throws(() => statSync(`${authDir}.identity-lock.json`), { code: 'ENOENT' });
    const check = run(hash(currentBytes), '--check');
    assert.equal(check.status, 0, check.stderr);
    assert.equal(check.stdout, 'LEGACY_IDENTITY_BASELINE_STABLE=true\nLEGACY_IDENTITY_SCAN_REQUIRED=true\n');
    assert.throws(() => statSync(`${authDir}.identity-bundle.json`), { code: 'ENOENT' });
    const write = run(hash(currentBytes), '--write');
    assert.equal(write.status, 0, write.stderr);
    assert.match(write.stdout, /^LEGACY_IDENTITY_LOCK_FINGERPRINT=[a-f0-9]{64}\n/);
    assert.equal(write.stdout.includes(JID), false);
    assert.equal(write.stderr.includes(JID), false);
    const bundle = `${authDir}.identity-bundle.json`;
    assert.equal(statSync(bundle).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(bundle, 'utf8')).requiresOwnerScan, true);
    assert.equal(run(hash(currentBytes), '--write').stdout, write.stdout);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
