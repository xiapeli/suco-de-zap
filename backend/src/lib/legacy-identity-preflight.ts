import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { legacyIdentityLockFingerprint, type LegacyIdentityProof } from './confidential-auth-state.js';

export class LegacyIdentityPreflightError extends Error {
  constructor(readonly code: 'LEGACY_SNAPSHOT_UNTRUSTED' | 'LEGACY_AUTH_INVALID' | 'LEGACY_IDENTITY_MISMATCH') {
    super(code);
    this.name = 'LegacyIdentityPreflightError';
  }
}

function jidFromCreds(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 1024 * 1024)
    throw new LegacyIdentityPreflightError('LEGACY_AUTH_INVALID');
  try {
    const record = JSON.parse(Buffer.from(bytes).toString('utf8')) as { me?: { id?: unknown } };
    const id = record?.me?.id;
    const jid = typeof id === 'string' ? jidNormalizedUser(id.trim()) : '';
    if (!/^\d{5,20}@s\.whatsapp\.net$/.test(jid))
      throw new LegacyIdentityPreflightError('LEGACY_AUTH_INVALID');
    return jid;
  } catch {
    throw new LegacyIdentityPreflightError('LEGACY_AUTH_INVALID');
  }
}

/**
 * A snapshot hash must come from an independently trusted receipt predating
 * this migration. Hashing the current volume and passing that hash proves nothing.
 * The JID is returned only for delivery through the attested private channel.
 */
export function prepareLegacyIdentityLock(args: {
  currentCreds: Uint8Array;
  trustedSnapshotCreds: Uint8Array;
  pinnedSnapshotSha256: string;
}): { jid: string; proof: LegacyIdentityProof; fingerprint: string } {
  if (!/^[a-f0-9]{64}$/.test(args.pinnedSnapshotSha256))
    throw new LegacyIdentityPreflightError('LEGACY_SNAPSHOT_UNTRUSTED');
  const actual = createHash('sha256').update(args.trustedSnapshotCreds).digest();
  if (!timingSafeEqual(actual, Buffer.from(args.pinnedSnapshotSha256, 'hex')))
    throw new LegacyIdentityPreflightError('LEGACY_SNAPSHOT_UNTRUSTED');
  const priorJid = jidFromCreds(args.trustedSnapshotCreds);
  const currentJid = jidFromCreds(args.currentCreds);
  const prior = Buffer.from(priorJid, 'utf8');
  const current = Buffer.from(currentJid, 'utf8');
  if (prior.length !== current.length || !timingSafeEqual(prior, current))
    throw new LegacyIdentityPreflightError('LEGACY_IDENTITY_MISMATCH');
  return lockForJid(currentJid);
}

function lockForJid(jid: string): { jid: string; proof: LegacyIdentityProof; fingerprint: string } {
  const salt = randomBytes(16).toString('hex');
  const proof: LegacyIdentityProof = {
    version: 1,
    salt,
    digest: scryptSync(jid, Buffer.from(salt, 'hex'), 32).toString('hex'),
  };
  return { jid, proof, fingerprint: legacyIdentityLockFingerprint(proof) };
}

/**
 * Use only when a prior independent snapshot does not exist. The hash pins the
 * stopped volume's bytes for cutover consistency; it is NOT identity evidence.
 * A scan from the owner's WhatsApp must confirm the same JID before ingestion.
 */
export function prepareScanBoundLegacyIdentityLock(args: {
  currentCreds: Uint8Array;
  pinnedCurrentSha256: string;
}): { jid: string; proof: LegacyIdentityProof; fingerprint: string } {
  if (!/^[a-f0-9]{64}$/.test(args.pinnedCurrentSha256))
    throw new LegacyIdentityPreflightError('LEGACY_SNAPSHOT_UNTRUSTED');
  const actual = createHash('sha256').update(args.currentCreds).digest();
  if (!timingSafeEqual(actual, Buffer.from(args.pinnedCurrentSha256, 'hex')))
    throw new LegacyIdentityPreflightError('LEGACY_SNAPSHOT_UNTRUSTED');
  return lockForJid(jidFromCreds(args.currentCreds));
}
