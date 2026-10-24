import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  BufferJSON,
  initAuthCreds,
  jidNormalizedUser,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';

const MAGIC = Buffer.from('SUCOAUTH1');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_SEALED_BYTES = 4 * 1024 * 1024;

type KeyData = Partial<{ [T in keyof SignalDataTypeMap]: Record<string, SignalDataTypeMap[T]> }>;
type AuthDocument = {
  version: 1;
  expectedJid: string | null;
  identitySource: 'legacy-pinned' | 'new-pairing' | null;
  creds: AuthenticationCreds;
  keys: KeyData;
};

export interface SealedAuthRecord { revision: string; ciphertext: Uint8Array }

/** The v1 verifier copied from a previously pinned, private owner snapshot. */
export interface LegacyIdentityProof { version: 1; salt: string; digest: string }

export function legacyIdentityLockFingerprint(proof: LegacyIdentityProof): string {
  if (proof?.version !== 1 || !/^[a-f0-9]{32}$/.test(proof.salt) ||
      !/^[a-f0-9]{64}$/.test(proof.digest))
    throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
  return createHash('sha256').update('suco-identity-lock-v1\0')
    .update(proof.salt).update('\0').update(proof.digest).digest('hex');
}

/** The attested bootstrap supplies a tenant-scoped implementation with a single-writer lease. */
export interface EncryptedAuthStore {
  read(): Promise<SealedAuthRecord | null>;
  compareAndSwap(expectedRevision: string | null, ciphertext: Uint8Array): Promise<string>;
  /** Must durably preserve the exact old ciphertext before a pairing reset. */
  archive(record: SealedAuthRecord): Promise<void>;
}

export type ConfidentialAuthCode =
  | 'AUTH_STATE_INPUT'
  | 'AUTH_STATE_CORRUPT'
  | 'AUTH_STATE_CONFLICT'
  | 'AUTH_STATE_STORE'
  | 'AUTH_STATE_AUTH'
  | 'AUTH_STATE_CLOSED'
  | 'PAIRING_ACCOUNT_MISMATCH'
  | 'PAIRING_IDENTITY_UNAVAILABLE'
  | 'PAIRING_BACKUP_FAILED';

export class ConfidentialAuthError extends Error {
  constructor(readonly code: ConfidentialAuthCode) { super(code); this.name = 'ConfidentialAuthError'; }
}

export interface ConfidentialAuthAdapter {
  load(): Promise<{ state: AuthenticationState; saveCreds(): Promise<void> }>;
  hasIdentity(): boolean;
  hasImportedLegacyIdentity(): boolean;
  identityMatches(raw: string | null | undefined): boolean;
  assertOrEstablishIdentity(raw: string | null | undefined): Promise<void>;
  /** One-time migration of only the bound JID; old Signal credentials stay behind. */
  importLegacyIdentity(raw: string, proof: LegacyIdentityProof, pinnedFingerprint: string): Promise<void>;
  /** Archives the old encrypted state and keeps the same expected WhatsApp. */
  beginFreshPairing(): Promise<void>;
  /** Archives and clears session keys after logout while retaining the account lock. */
  clearCurrent(): Promise<void>;
  close(): void;
}

function normalizedJid(raw: string | null | undefined): string | null {
  const jid = typeof raw === 'string' ? jidNormalizedUser(raw.trim()) : '';
  return /^\d{5,20}@s\.whatsapp\.net$/.test(jid) ? jid : null;
}

function equalJid(a: string, b: string): boolean {
  const aa = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function validDocument(value: unknown): value is AuthDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<AuthDocument>;
  return doc.version === 1 &&
    (doc.expectedJid === null || normalizedJid(doc.expectedJid) === doc.expectedJid) &&
    (doc.identitySource === null || doc.identitySource === 'legacy-pinned' || doc.identitySource === 'new-pairing') &&
    (doc.expectedJid === null ? doc.identitySource === null : doc.identitySource !== null) &&
    !!doc.creds && typeof doc.creds === 'object' &&
    !!doc.keys && typeof doc.keys === 'object' && !Array.isArray(doc.keys);
}

/**
 * Only ciphertext crosses the store boundary. Key release, attestation and
 * tenant authorization belong to the confidential bootstrap, never to an env flag.
 */
export async function createConfidentialAuthState(args: {
  tenantId: string;
  key: Uint8Array;
  store: EncryptedAuthStore;
}): Promise<ConfidentialAuthAdapter> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(args.tenantId) ||
      !(args.key instanceof Uint8Array) || args.key.length !== 32 ||
      !args.store || typeof args.store.read !== 'function' ||
      typeof args.store.compareAndSwap !== 'function' || typeof args.store.archive !== 'function') {
    throw new ConfidentialAuthError('AUTH_STATE_INPUT');
  }
  const encKey = Buffer.from(hkdfSync('sha256', args.key, Buffer.from(args.tenantId), 'suco-auth-state-v1', 32));
  const aad = Buffer.from(`suco-auth-state-v1\0${args.tenantId}`, 'utf8');
  let closed = false;
  let failure: ConfidentialAuthError | null = null;
  let revision: string | null = null;
  let document: AuthDocument = { version: 1, expectedJid: null, identitySource: null, creds: initAuthCreds(), keys: {} };
  let queue: Promise<unknown> = Promise.resolve();
  const ensureOpen = () => {
    if (closed) throw new ConfidentialAuthError('AUTH_STATE_CLOSED');
    if (failure) throw failure;
  };
  const seal = (value: AuthDocument): Buffer => {
    const clear = Buffer.from(JSON.stringify(value, BufferJSON.replacer), 'utf8');
    if (clear.length > MAX_SEALED_BYTES - 128) throw new ConfidentialAuthError('AUTH_STATE_INPUT');
    const nonce = randomBytes(NONCE_LENGTH);
    try {
      const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
      cipher.setAAD(aad);
      const encrypted = Buffer.concat([cipher.update(clear), cipher.final()]);
      return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
    } finally { clear.fill(0); }
  };
  const unseal = (sealed: Uint8Array): AuthDocument => {
    const blob = Buffer.from(sealed);
    if (blob.length < MAGIC.length + NONCE_LENGTH + TAG_LENGTH + 1 ||
        blob.length > MAX_SEALED_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new ConfidentialAuthError('AUTH_STATE_CORRUPT');
    }
    try {
      const nonce = blob.subarray(MAGIC.length, MAGIC.length + NONCE_LENGTH);
      const tag = blob.subarray(MAGIC.length + NONCE_LENGTH, MAGIC.length + NONCE_LENGTH + TAG_LENGTH);
      const encrypted = blob.subarray(MAGIC.length + NONCE_LENGTH + TAG_LENGTH);
      const decipher = createDecipheriv('aes-256-gcm', encKey, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try {
        const parsed: unknown = JSON.parse(clear.toString('utf8'), BufferJSON.reviver);
        if (!validDocument(parsed)) throw new Error('invalid document');
        if (parsed.expectedJid && parsed.creds.me?.id &&
            !equalJid(parsed.expectedJid, normalizedJid(parsed.creds.me.id) || '')) {
          throw new Error('identity mismatch');
        }
        return parsed;
      } finally { clear.fill(0); }
    } catch { throw new ConfidentialAuthError('AUTH_STATE_CORRUPT'); }
  };
  const run = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(async () => {
      ensureOpen();
      try { return await task(); }
      catch (error) {
        const sanitized = error instanceof ConfidentialAuthError ? error : new ConfidentialAuthError('AUTH_STATE_STORE');
        if (!['PAIRING_ACCOUNT_MISMATCH', 'PAIRING_IDENTITY_UNAVAILABLE', 'PAIRING_BACKUP_FAILED'].includes(sanitized.code)) {
          failure = sanitized;
        }
        throw sanitized;
      }
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const commit = async () => {
    if (document.expectedJid && document.creds.me?.id &&
        !equalJid(document.expectedJid, normalizedJid(document.creds.me.id) || '')) {
      throw new ConfidentialAuthError('PAIRING_ACCOUNT_MISMATCH');
    }
    const sealed = seal(document);
    try {
      const nextRevision = await args.store.compareAndSwap(revision, sealed);
      if (typeof nextRevision !== 'string' || !nextRevision) throw new ConfidentialAuthError('AUTH_STATE_CONFLICT');
      revision = nextRevision;
    } catch (error) {
      if (error instanceof ConfidentialAuthError) throw error;
      throw new ConfidentialAuthError('AUTH_STATE_STORE');
    } finally { sealed.fill(0); }
  };

  try {
    const previous = await args.store.read();
    if (previous) {
      if (typeof previous.revision !== 'string' || !previous.revision) throw new ConfidentialAuthError('AUTH_STATE_CORRUPT');
      revision = previous.revision;
      document = unseal(previous.ciphertext);
    } else {
      await commit();
    }
  } catch (error) {
    encKey.fill(0);
    throw error instanceof ConfidentialAuthError ? error : new ConfidentialAuthError('AUTH_STATE_STORE');
  }

  const adapter: ConfidentialAuthAdapter = {
    async load() {
      ensureOpen();
      // Every socket gets fresh wrappers over the current in-memory snapshot.
      const state: AuthenticationState = {
        creds: document.creds,
        keys: {
          async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
            ensureOpen();
            const result: Record<string, SignalDataTypeMap[T]> = {};
            const bucket = document.keys[type] as Record<string, SignalDataTypeMap[T]> | undefined;
            for (const id of ids) {
              let value = bucket?.[id];
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value) as unknown as SignalDataTypeMap[T];
              }
              if (value !== undefined) result[id] = value;
            }
            return result;
          },
          async set(data: SignalDataSet) {
            await run(async () => {
              for (const type of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
                const updates = data[type] as Record<string, unknown> | undefined;
                if (!updates) continue;
                const bucket = (document.keys[type] || {}) as Record<string, unknown>;
                for (const [id, value] of Object.entries(updates)) {
                  if (value === null) delete bucket[id];
                  else bucket[id] = value;
                }
                (document.keys as Record<string, unknown>)[type] = bucket;
              }
              await commit();
            });
          },
        },
      };
      return { state, saveCreds: () => run(commit) };
    },
    hasIdentity() { ensureOpen(); return document.expectedJid !== null; },
    hasImportedLegacyIdentity() { ensureOpen(); return document.identitySource === 'legacy-pinned'; },
    identityMatches(raw) {
      ensureOpen();
      const candidate = normalizedJid(raw);
      return !!candidate && !!document.expectedJid && equalJid(document.expectedJid, candidate);
    },
    async assertOrEstablishIdentity(raw) {
      await run(async () => {
        const candidate = normalizedJid(raw);
        if (!candidate) throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
        if (document.expectedJid) {
          if (!equalJid(document.expectedJid, candidate)) throw new ConfidentialAuthError('PAIRING_ACCOUNT_MISMATCH');
          return;
        }
        document.expectedJid = candidate;
        document.identitySource = 'new-pairing';
        await commit();
      });
    },
    async importLegacyIdentity(raw, proof, pinnedFingerprint) {
      await run(async () => {
        const candidate = normalizedJid(raw);
        if (!candidate || !/^[a-f0-9]{64}$/.test(pinnedFingerprint))
          throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
        const actualFingerprint = legacyIdentityLockFingerprint(proof);
        if (!timingSafeEqual(Buffer.from(actualFingerprint, 'hex'), Buffer.from(pinnedFingerprint, 'hex')))
          throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
        const digest = scryptSync(candidate, Buffer.from(proof.salt, 'hex'), 32);
        if (!timingSafeEqual(digest, Buffer.from(proof.digest, 'hex')))
          throw new ConfidentialAuthError('PAIRING_ACCOUNT_MISMATCH');
        if (document.expectedJid) {
          if (!equalJid(document.expectedJid, candidate))
            throw new ConfidentialAuthError('PAIRING_ACCOUNT_MISMATCH');
          if (document.identitySource !== 'legacy-pinned')
            throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
          return;
        }
        // Import is only valid before any new WhatsApp has paired in this TEE.
        if (document.creds.me?.id) throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
        document.expectedJid = candidate;
        document.identitySource = 'legacy-pinned';
        await commit();
      });
    },
    async beginFreshPairing() {
      await run(async () => {
        if (!document.expectedJid) throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
        if (revision === null) throw new ConfidentialAuthError('PAIRING_BACKUP_FAILED');
        const old = await args.store.read();
        if (!old || old.revision !== revision) throw new ConfidentialAuthError('AUTH_STATE_CONFLICT');
        try { await args.store.archive(old); }
        catch { throw new ConfidentialAuthError('PAIRING_BACKUP_FAILED'); }
        document = { version: 1, expectedJid: document.expectedJid,
          identitySource: document.identitySource, creds: initAuthCreds(), keys: {} };
        await commit();
      });
    },
    async clearCurrent() {
      await run(async () => {
        if (revision === null) throw new ConfidentialAuthError('PAIRING_BACKUP_FAILED');
        const old = await args.store.read();
        if (!old || old.revision !== revision) throw new ConfidentialAuthError('AUTH_STATE_CONFLICT');
        try { await args.store.archive(old); }
        catch { throw new ConfidentialAuthError('PAIRING_BACKUP_FAILED'); }
        document = { version: 1, expectedJid: document.expectedJid,
          identitySource: document.identitySource, creds: initAuthCreds(), keys: {} };
        await commit();
      });
    },
    close() { closed = true; encKey.fill(0); },
  };
  return adapter;
}
