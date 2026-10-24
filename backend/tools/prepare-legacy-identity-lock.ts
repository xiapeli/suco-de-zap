/** One-time offline bridge from preserved Baileys creds to a pinned identity verifier. */
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { legacyIdentityLockFingerprint, type LegacyIdentityProof } from '../src/lib/confidential-auth-state.js';
import { LegacyIdentityPreflightError, prepareLegacyIdentityLock,
  prepareScanBoundLegacyIdentityLock } from '../src/lib/legacy-identity-preflight.js';

type Input = { current: string; write: boolean } & (
  { basis: 'snapshot'; snapshot: string; snapshotSha256: string } |
  { basis: 'owner-scan'; currentSha256: string }
);

function argumentsOrThrow(): Input {
  const argv = process.argv.slice(2);
  if (argv[0] !== '--current') throw new Error('USAGE');
  const current = resolve(argv[1] || '');
  if (basename(current) !== 'creds.json') throw new Error('USAGE');
  if (argv.length === 7 && argv[2] === '--snapshot' && argv[4] === '--snapshot-sha256' &&
      ['--check', '--write'].includes(argv[6])) {
    const snapshot = resolve(argv[3]);
    if (current === snapshot) throw new Error('USAGE');
    return { basis: 'snapshot', current, snapshot, snapshotSha256: argv[5], write: argv[6] === '--write' };
  }
  if (argv.length === 6 && argv[2] === '--current-sha256' && argv[4] === '--owner-scan-required' &&
      ['--check', '--write'].includes(argv[5])) {
    return { basis: 'owner-scan', current, currentSha256: argv[3], write: argv[5] === '--write' };
  }
  throw new Error('USAGE');
}

function readRegularFile(path: string): { bytes: Buffer; device: number; inode: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('INPUT_UNSAFE');
    return { bytes: readFileSync(fd), device: stat.dev, inode: stat.ino };
  } finally { closeSync(fd); }
}

function readExistingLock(path: string, jid: string): LegacyIdentityProof {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 1024)
    throw new Error('LOCK_UNSAFE');
  const proof = JSON.parse(readFileSync(path, 'utf8')) as LegacyIdentityProof;
  legacyIdentityLockFingerprint(proof);
  const derived = scryptSync(jid, Buffer.from(proof.salt, 'hex'), 32);
  if (!timingSafeEqual(derived, Buffer.from(proof.digest, 'hex'))) throw new Error('LOCK_UNSAFE');
  return proof;
}

function writeLock(path: string, proof: LegacyIdentityProof, jid: string): LegacyIdentityProof {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readExistingLock(path, jid);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify(proof));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return proof;
}

function writeBundle(path: string, jid: string, proof: LegacyIdentityProof): void {
  const contents = JSON.stringify({ version: 1, jid, proof, requiresOwnerScan: true });
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 2048)
      throw new Error('BUNDLE_UNSAFE');
    const existing = readFileSync(path, 'utf8');
    const expected = createHash('sha256').update(contents).digest();
    const actual = createHash('sha256').update(existing).digest();
    if (!timingSafeEqual(expected, actual)) throw new Error('BUNDLE_CONFLICT');
    return;
  }
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

try {
  const args = argumentsOrThrow();
  const currentFile = readRegularFile(args.current);
  const current = currentFile.bytes;
  const result = args.basis === 'snapshot' ? (() => {
    const snapshotFile = readRegularFile(args.snapshot);
    if (currentFile.device === snapshotFile.device && currentFile.inode === snapshotFile.inode)
      throw new LegacyIdentityPreflightError('LEGACY_SNAPSHOT_UNTRUSTED');
    return prepareLegacyIdentityLock({
      currentCreds: current,
      trustedSnapshotCreds: snapshotFile.bytes,
      pinnedSnapshotSha256: args.snapshotSha256,
    });
  })() : prepareScanBoundLegacyIdentityLock({
    currentCreds: current, pinnedCurrentSha256: args.currentSha256,
  });
  const currentNow = readRegularFile(args.current).bytes;
  if (!timingSafeEqual(createHash('sha256').update(current).digest(),
      createHash('sha256').update(currentNow).digest())) throw new Error('CURRENT_AUTH_CHANGED');
  if (!args.write) {
    console.log(args.basis === 'snapshot' ? 'LEGACY_IDENTITY_MATCH=true' :
      'LEGACY_IDENTITY_BASELINE_STABLE=true\nLEGACY_IDENTITY_SCAN_REQUIRED=true');
  } else {
    const lockPath = `${dirname(args.current)}.identity-lock.json`;
    const bundlePath = `${dirname(args.current)}.identity-bundle.json`;
    const proof = writeLock(lockPath, result.proof, result.jid);
    writeBundle(bundlePath, result.jid, proof);
    console.log(`LEGACY_IDENTITY_LOCK_FINGERPRINT=${legacyIdentityLockFingerprint(proof)}`);
    console.log(`LEGACY_IDENTITY_BUNDLE_PATH=${bundlePath}`);
    console.log('LEGACY_IDENTITY_SCAN_REQUIRED=true');
  }
} catch (error) {
  const code = (error as { code?: unknown }).code;
  console.error(typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'LEGACY_IDENTITY_PREPARE_FAILED');
  process.exitCode = 1;
}
