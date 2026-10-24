import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { SupabaseSpoolOptions } from './supabase-ingestion-spool.js';
import { IngestionSpoolError } from './ingestion-spool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^[A-Za-z0-9._-]{1,128}$/;
const REVISION = /^[1-9][0-9]{0,18}$/;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

export type ChatMetadata = { jid: string; name: string | null; is_group: boolean;
  tracked?: boolean; archived?: boolean; tracked_since?: string | null };
export type ContactMetadata = { jid: string; name: string | null; notify: string | null };
export type LidMetadata = { lid: string; pn: string };
type MetadataDocument =
  | ({ kind: 'chat' } & ChatMetadata)
  | ({ kind: 'contact' } & ContactMetadata)
  | ({ kind: 'lid' } & LidMetadata);
type Cached = { document: MetadataDocument; revision: string };
type CipherRow = {
  object_id: string; key_epoch: number; nonce_hex: string;
  ciphertext_hex: string; revision: string;
};

export interface ConfidentialMetadataStore {
  /** Decrypt all metadata inside the private worker before WhatsApp starts. */
  load(): Promise<void>;
  putChat(jid: string, name: string | null, isGroup: boolean): Promise<void>;
  setChatTracking(jid: string, tracked: boolean): Promise<ChatMetadata>;
  putContact(jid: string, value: { name: string | null; notify: string | null }): Promise<void>;
  putLidMap(lid: string, pn: string): Promise<void>;
  chatList(): Promise<ChatMetadata[]>;
  contactList(): Promise<ContactMetadata[]>;
  lidMapList(): Promise<LidMetadata[]>;
  contactName(jid: string): Promise<string | null>;
  resolveLid(lid: string): Promise<string | null>;
  close(): void;
}

function fail(code: 'INGESTION_SPOOL_INPUT' | 'INGESTION_SPOOL_AUTH' |
  'INGESTION_SPOOL_REMOTE' | 'INGESTION_SPOOL_UNREADABLE'): never {
  throw new IngestionSpoolError(code);
}

function validJid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f]/.test(value) && value.includes('@');
}

function validName(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 1024);
}

function validDocument(value: unknown): value is MetadataDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<MetadataDocument>;
  if (doc.kind === 'chat') return validJid(doc.jid) && validName(doc.name) &&
    typeof doc.is_group === 'boolean' &&
    (doc.tracked === undefined || typeof doc.tracked === 'boolean') &&
    (doc.tracked_since === undefined || doc.tracked_since === null ||
      (typeof doc.tracked_since === 'string' && Number.isFinite(Date.parse(doc.tracked_since)))) &&
    (doc.archived === undefined || typeof doc.archived === 'boolean');
  if (doc.kind === 'contact') return validJid(doc.jid) && validName(doc.name) && validName(doc.notify);
  if (doc.kind === 'lid') return validJid(doc.lid) && validJid(doc.pn);
  return false;
}

function validJwt(jwt: string, ownerId: string): boolean {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload.role === 'authenticated' && payload.sub === ownerId &&
      typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000) + 5;
  } catch { return false; }
}

function opaqueUuid(digest: Buffer): string {
  const id = Buffer.from(digest.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x80;
  id[8] = (id[8] & 0x3f) | 0x80;
  const h = id.toString('hex');
  id.fill(0);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Confidential worker only. Names and JIDs never enter URL, row keys or logs. */
export function createConfidentialMetadataStore(options: SupabaseSpoolOptions): ConfidentialMetadataStore {
  let endpoint: URL;
  try { endpoint = new URL(options.url); }
  catch { return fail('INGESTION_SPOOL_INPUT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !UUID.test(options.ownerId) || !TENANT.test(options.tenantId) ||
      !Number.isInteger(options.keyEpoch) || options.keyEpoch < 1 || options.keyEpoch > 1_000_000_000 ||
      !(options.key instanceof Uint8Array) || options.key.length !== 32 ||
      !options.publishableKey || options.publishableKey.startsWith('sb_secret_') ||
      typeof options.userJwt !== 'function') fail('INGESTION_SPOOL_INPUT');
  if (options.publishableKey.split('.').length === 3) {
    try {
      const role = JSON.parse(Buffer.from(options.publishableKey.split('.')[1], 'base64url').toString('utf8')).role;
      if (role !== 'anon') fail('INGESTION_SPOOL_INPUT');
    } catch { fail('INGESTION_SPOOL_INPUT'); }
  }
  const base = endpoint.toString().replace(/\/$/, '');
  const salt = Buffer.from(`${options.tenantId}\0${options.ownerId}`, 'utf8');
  const encKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-private-metadata-v1:enc', 32));
  const nameKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-private-metadata-v1:name', 32));
  const fetcher = options.fetcher ?? fetch;
  const cache = new Map<string, Cached>();
  let loaded = false;
  let closed = false;
  let writeQueue: Promise<unknown> = Promise.resolve();
  const ensureOpen = () => { if (closed) fail('INGESTION_SPOOL_INPUT'); };
  const objectId = (kind: MetadataDocument['kind'], jid: string) => opaqueUuid(
    createHmac('sha256', nameKey).update(kind).update('\0').update(jid).digest()
  );
  const documentId = (doc: MetadataDocument) => objectId(doc.kind, doc.kind === 'lid' ? doc.lid : doc.jid);
  const aad = (id: string, epoch: number) => Buffer.from(
    `suco-private-metadata-v1\0${options.tenantId}\0${options.ownerId}\0${id}\0${epoch}`, 'utf8'
  );

  async function rpc(name: string, body: Record<string, unknown>, idempotent: boolean): Promise<unknown> {
    ensureOpen();
    const attempts = idempotent ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const jwt = await options.userJwt();
      if (!validJwt(jwt, options.ownerId)) fail('INGESTION_SPOOL_AUTH');
      try {
        const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: { apikey: options.publishableKey, Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json', Accept: 'application/json' },
          cache: 'no-store', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) fail('INGESTION_SPOOL_AUTH');
          if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) continue;
          fail('INGESTION_SPOOL_REMOTE');
        }
        return await response.json();
      } catch (error) {
        if (error instanceof IngestionSpoolError) throw error;
        if (attempt + 1 >= attempts) fail('INGESTION_SPOOL_REMOTE');
      }
    }
    return fail('INGESTION_SPOOL_REMOTE');
  }

  function seal(doc: MetadataDocument, id: string): { nonce: string; ciphertext: string } {
    const clear = Buffer.from(JSON.stringify(doc), 'utf8');
    if (clear.length + 16 > MAX_CIPHERTEXT_BYTES) { clear.fill(0); fail('INGESTION_SPOOL_INPUT'); }
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
      cipher.setAAD(aad(id, options.keyEpoch));
      const encrypted = Buffer.concat([cipher.update(clear), cipher.final(), cipher.getAuthTag()]);
      const result = { nonce: nonce.toString('hex'), ciphertext: encrypted.toString('hex') };
      encrypted.fill(0);
      return result;
    } finally { clear.fill(0); }
  }

  function unseal(row: CipherRow): MetadataDocument {
    try {
      if (!UUID.test(row.object_id) || row.key_epoch !== options.keyEpoch ||
          typeof row.revision !== 'string' || !REVISION.test(row.revision) ||
          typeof row.nonce_hex !== 'string' || !/^[0-9a-f]{24}$/.test(row.nonce_hex) ||
          typeof row.ciphertext_hex !== 'string' || !/^[0-9a-f]+$/.test(row.ciphertext_hex) ||
          row.ciphertext_hex.length < 64 || row.ciphertext_hex.length > MAX_CIPHERTEXT_BYTES * 2 ||
          row.ciphertext_hex.length % 2 !== 0) throw Error('shape');
      const sealed = Buffer.from(row.ciphertext_hex, 'hex');
      let clear: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(row.nonce_hex, 'hex'));
        decipher.setAAD(aad(row.object_id, row.key_epoch));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        clear = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      } finally { sealed.fill(0); }
      let parsed: unknown;
      try { parsed = JSON.parse(clear.toString('utf8')); }
      finally { clear.fill(0); }
      if (!validDocument(parsed) || documentId(parsed) !== row.object_id) throw Error('identity');
      return parsed;
    } catch { return fail('INGESTION_SPOOL_UNREADABLE'); }
  }

  async function load() {
    ensureOpen();
    if (loaded) return;
    cache.clear();
    let after: string | null = null;
    for (;;) {
      const result = await rpc('suco_meta_list', { p_after: after, p_limit: 100 }, true);
      if (!Array.isArray(result) || result.length > 100) fail('INGESTION_SPOOL_REMOTE');
      for (const raw of result) {
        const row = raw as CipherRow;
        const doc = unseal(row);
        cache.set(row.object_id, { document: doc, revision: row.revision });
      }
      if (result.length < 100) break;
      after = (result[result.length - 1] as CipherRow).object_id;
      if (!UUID.test(after)) fail('INGESTION_SPOOL_REMOTE');
    }
    loaded = true;
  }

  function queue<T>(task: () => Promise<T>): Promise<T> {
    const current = writeQueue.then(task);
    writeQueue = current.catch(() => undefined);
    return current;
  }

  async function put(build: () => MetadataDocument): Promise<MetadataDocument> {
    return await queue(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        await load();
        const doc = build();
        if (!validDocument(doc)) fail('INGESTION_SPOOL_INPUT');
        const id = documentId(doc);
        const previous = cache.get(id);
        if (previous && JSON.stringify(previous.document) === JSON.stringify(doc)) return doc;
        const encrypted = seal(doc, id);
        try {
          const next = await rpc('suco_meta_put', {
            p_object_id: id, p_expected_revision: previous?.revision ?? '0',
            p_key_epoch: options.keyEpoch,
            p_nonce_hex: encrypted.nonce, p_ciphertext_hex: encrypted.ciphertext,
          }, false);
          const expected = previous ? BigInt(previous.revision) + 1n : 1n;
          if (typeof next !== 'string' || !REVISION.test(next) || BigInt(next) !== expected)
            fail('INGESTION_SPOOL_REMOTE');
          cache.set(id, { document: doc, revision: next });
          return doc;
        } catch (error) {
          loaded = false;
          cache.clear();
          if (attempt === 1) throw error;
        }
      }
      return fail('INGESTION_SPOOL_REMOTE');
    });
  }

  return {
    load,
    putChat(jid, name, isGroup) {
      if (!validJid(jid) || !validName(name) || typeof isGroup !== 'boolean') fail('INGESTION_SPOOL_INPUT');
      return put(() => {
        const old = cache.get(objectId('chat', jid))?.document;
        return { kind: 'chat', jid, name: name ?? (old?.kind === 'chat' ? old.name : null),
          is_group: isGroup, tracked: old?.kind === 'chat' ? old.tracked : false,
          archived: old?.kind === 'chat' ? old.archived : false,
          tracked_since: old?.kind === 'chat' ? old.tracked_since : null };
      }).then(() => undefined);
    },
    setChatTracking(jid, tracked) {
      if (!validJid(jid) || typeof tracked !== 'boolean') fail('INGESTION_SPOOL_INPUT');
      return put(() => {
        const old = cache.get(objectId('chat', jid))?.document;
        if (!old || old.kind !== 'chat') fail('INGESTION_SPOOL_INPUT');
        return { ...old, tracked, tracked_since: tracked && !old.tracked
          ? new Date().toISOString() : old.tracked_since ?? null };
      }).then(doc => {
        if (doc.kind !== 'chat') fail('INGESTION_SPOOL_REMOTE');
        return { jid: doc.jid, name: doc.name, is_group: doc.is_group,
          tracked: doc.tracked, archived: doc.archived, tracked_since: doc.tracked_since };
      });
    },
    putContact(jid, value) {
      if (!validJid(jid) || !value || !validName(value.name) || !validName(value.notify)) fail('INGESTION_SPOOL_INPUT');
      return put(() => {
        const old = cache.get(objectId('contact', jid))?.document;
        return { kind: 'contact', jid,
          name: value.name ?? (old?.kind === 'contact' ? old.name : null),
          notify: value.notify ?? (old?.kind === 'contact' ? old.notify : null) };
      }).then(() => undefined);
    },
    putLidMap(lid, pn) {
      if (!validJid(lid) || !validJid(pn)) fail('INGESTION_SPOOL_INPUT');
      return put(() => ({ kind: 'lid', lid, pn })).then(() => undefined);
    },
    async chatList() { await load(); return [...cache.values()].flatMap((v) => v.document.kind === 'chat'
      ? [{ jid: v.document.jid, name: v.document.name, is_group: v.document.is_group,
        tracked: v.document.tracked ?? false, archived: v.document.archived ?? false,
        tracked_since: v.document.tracked_since ?? null }] : []); },
    async contactList() { await load(); return [...cache.values()].flatMap((v) => v.document.kind === 'contact'
      ? [{ jid: v.document.jid, name: v.document.name, notify: v.document.notify }] : []); },
    async lidMapList() { await load(); return [...cache.values()].flatMap((v) => v.document.kind === 'lid'
      ? [{ lid: v.document.lid, pn: v.document.pn }] : []); },
    async contactName(jid) {
      await load();
      const doc = cache.get(objectId('contact', jid))?.document;
      return doc?.kind === 'contact' ? doc.name || doc.notify : null;
    },
    async resolveLid(lid) {
      await load();
      const doc = cache.get(objectId('lid', lid))?.document;
      return doc?.kind === 'lid' ? doc.pn : null;
    },
    close() {
      if (closed) return;
      closed = true; loaded = false; cache.clear();
      encKey.fill(0); nameKey.fill(0);
    },
  };
}
