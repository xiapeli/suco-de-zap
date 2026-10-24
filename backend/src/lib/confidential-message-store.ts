import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { createSupabaseIngestionSpool, type SupabaseSpoolOptions } from './supabase-ingestion-spool.js';
import { IngestionSpoolError, type StagedMessage } from './ingestion-spool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
type CipherRow = {
  object_id: string;
  key_epoch: number;
  nonce_hex: string;
  ciphertext_hex: string;
  revision: number;
};

export interface MessageQuery {
  chatJid?: string;
  from?: Date;
  before?: Date;
  text?: string;
  limit?: number;
}

export interface ConfidentialMessageStore {
  /** Durable ciphertext outbox write; call before commit. */
  stage(message: StagedMessage): Promise<void>;
  /** Idempotent ciphertext commit, then outbox ack. */
  commit(message: StagedMessage): Promise<void>;
  /** Convenience sequence for a newly received message. */
  ingest(message: StagedMessage): Promise<void>;
  /** Restore pending work after VM recreation. Call before WhatsApp starts. */
  replay(beforeEach?: () => Promise<boolean>): Promise<number>;
  /** Worker-only snapshot for private aggregations; never send this to the control plane. */
  snapshot(): Promise<StagedMessage[]>;
  /** Observability without content or identifiers; ingestion clock is process-local. */
  evidence(): Promise<{
    lastIngestedAt: Date | null;
    lastSavedMessageAt: Date | null;
    lastCommittedMessageAt: Date | null;
    writeHealth: { lastWriteSuccessAt: Date | null; lastWriteFailureAt: Date | null; consecutiveWriteFailures: number };
  }>;
  /** Fetch opaque pages, decrypt inside the worker, then filter/sort privately. */
  query(options?: MessageQuery): Promise<StagedMessage[]>;
  stats(chatJid: string): Promise<{ totalMessages: number; firstMessageAt: Date | null; lastMessageAt: Date | null }>;
  close(): void;
}

function fail(code: 'INGESTION_SPOOL_INPUT' | 'INGESTION_SPOOL_AUTH' |
  'INGESTION_SPOOL_REMOTE' | 'INGESTION_SPOOL_UNREADABLE'): never {
  throw new IngestionSpoolError(code);
}

function uuidFromDigest(digest: Buffer): string {
  const id = Buffer.from(digest.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x80;
  id[8] = (id[8] & 0x3f) | 0x80;
  const h = id.toString('hex');
  id.fill(0);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function validMessage(value: unknown): value is StagedMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return typeof m.chat_jid === 'string' && m.chat_jid.length > 0 &&
    typeof m.id === 'string' && m.id.length > 0 &&
    (m.sender_jid === null || typeof m.sender_jid === 'string') &&
    (m.sender_name === null || typeof m.sender_name === 'string') &&
    typeof m.from_me === 'boolean' &&
    (m.body === null || typeof m.body === 'string') &&
    typeof m.msg_type === 'string' && m.msg_type.length > 0 &&
    m.ts instanceof Date && Number.isFinite(m.ts.valueOf());
}

function validUserJwt(jwt: string, ownerId: string): boolean {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload.role === 'authenticated' && payload.sub === ownerId &&
      typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000) + 5;
  } catch { return false; }
}

export function createConfidentialMessageStore(options: SupabaseSpoolOptions): ConfidentialMessageStore {
  const spool = createSupabaseIngestionSpool(options); // Validates key, URL, identity and public key.
  const salt = Buffer.from(`${options.tenantId}\0${options.ownerId}`, 'utf8');
  const encKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-private-messages-v1:enc', 32));
  const nameKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-private-messages-v1:name', 32));
  const base = new URL(options.url).toString().replace(/\/$/, '');
  const fetcher = options.fetcher ?? fetch;
  const cache = new Map<string, StagedMessage>();
  let loaded = false;
  let loadFlight: Promise<void> | null = null;
  let closed = false;
  let lastIngestedAt: Date | null = null;
  let lastCommittedMessageAt: Date | null = null;
  let lastWriteSuccessAt: Date | null = null;
  let lastWriteFailureAt: Date | null = null;
  let consecutiveWriteFailures = 0;
  const ensureOpen = () => { if (closed) fail('INGESTION_SPOOL_INPUT'); };
  const objectId = (chatJid: string, messageId: string) => uuidFromDigest(
    createHmac('sha256', nameKey).update(chatJid).update('\0').update(messageId).digest()
  );
  const aad = (id: string, epoch: number) => Buffer.from(
    `suco-private-messages-v1\0${options.tenantId}\0${options.ownerId}\0${id}\0${epoch}`, 'utf8'
  );

  async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    ensureOpen();
    for (let attempt = 0; attempt < 3; attempt++) {
      const jwt = await options.userJwt();
      if (!validUserJwt(jwt, options.ownerId)) fail('INGESTION_SPOOL_AUTH');
      try {
        const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: options.publishableKey, Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json', Accept: 'application/json',
          },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
          fail('INGESTION_SPOOL_REMOTE');
        }
        return await response.json();
      } catch (error) {
        if (error instanceof IngestionSpoolError) throw error;
        if (attempt === 2) fail('INGESTION_SPOOL_REMOTE');
      }
    }
    return fail('INGESTION_SPOOL_REMOTE');
  }

  function seal(message: StagedMessage, id: string) {
    const plaintext = Buffer.from(JSON.stringify({
      chat_jid: message.chat_jid, id: message.id,
      sender_jid: message.sender_jid, sender_name: message.sender_name,
      from_me: message.from_me, body: message.body,
      msg_type: message.msg_type, ts: message.ts.toISOString(),
    }), 'utf8');
    if (plaintext.length + 16 > MAX_CIPHERTEXT_BYTES) {
      plaintext.fill(0);
      return fail('INGESTION_SPOOL_INPUT');
    }
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encKey, nonce);
      cipher.setAAD(aad(id, options.keyEpoch));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
      const result = { nonce: nonce.toString('hex'), ciphertext: ciphertext.toString('hex') };
      ciphertext.fill(0);
      return result;
    } finally { plaintext.fill(0); }
  }

  function openRow(row: CipherRow): StagedMessage {
    try {
      if (!UUID.test(row.object_id) || row.key_epoch !== options.keyEpoch || row.revision !== 1 ||
          typeof row.nonce_hex !== 'string' || !/^[0-9a-f]{24}$/.test(row.nonce_hex) ||
          typeof row.ciphertext_hex !== 'string' || !/^[0-9a-f]+$/.test(row.ciphertext_hex) ||
          row.ciphertext_hex.length < 64 || row.ciphertext_hex.length > MAX_CIPHERTEXT_BYTES * 2 ||
          row.ciphertext_hex.length % 2 !== 0) throw Error('shape');
      const sealed = Buffer.from(row.ciphertext_hex, 'hex');
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(row.nonce_hex, 'hex'));
        decipher.setAAD(aad(row.object_id, row.key_epoch));
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      } finally { sealed.fill(0); }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>; }
      finally { plaintext.fill(0); }
      const message = {
        chat_jid: parsed.chat_jid, id: parsed.id,
        sender_jid: parsed.sender_jid, sender_name: parsed.sender_name,
        from_me: parsed.from_me, body: parsed.body,
        msg_type: parsed.msg_type, ts: new Date(parsed.ts as string),
      };
      if (!validMessage(message) || objectId(message.chat_jid, message.id) !== row.object_id) throw Error('identity');
      return message;
    } catch { return fail('INGESTION_SPOOL_UNREADABLE'); }
  }

  async function load() {
    ensureOpen();
    if (loaded) return;
    if (loadFlight) return loadFlight;
    loadFlight = (async () => {
      let after: string | null = null;
      for (;;) {
        const result = await rpc('suco_message_list', { p_after: after, p_limit: 100 });
        if (!Array.isArray(result) || result.length > 100) fail('INGESTION_SPOOL_REMOTE');
        for (const raw of result) {
          const row = raw as CipherRow;
          const opened = openRow(row);
          if (!cache.has(row.object_id)) cache.set(row.object_id, opened);
        }
        if (result.length < 100) break;
        after = (result[result.length - 1] as CipherRow).object_id;
        if (!UUID.test(after)) fail('INGESTION_SPOOL_REMOTE');
      }
      loaded = true;
    })();
    try { await loadFlight; }
    finally { loadFlight = null; }
  }

  async function commit(message: StagedMessage) {
    ensureOpen();
    if (!validMessage(message)) fail('INGESTION_SPOOL_INPUT');
    try {
      const id = objectId(message.chat_jid, message.id);
      const encrypted = seal(message, id);
      const receipt = await rpc('suco_message_commit', {
        p_object_id: id, p_key_epoch: options.keyEpoch,
        p_nonce_hex: encrypted.nonce, p_ciphertext_hex: encrypted.ciphertext,
      });
      if (!receipt || typeof receipt !== 'object' ||
          (receipt as { revision?: unknown }).revision !== 1 ||
          typeof (receipt as { created?: unknown }).created !== 'boolean')
        fail('INGESTION_SPOOL_REMOTE');
      if ((receipt as { created: boolean }).created) {
        cache.set(id, message);
        lastIngestedAt = new Date();
        lastCommittedMessageAt = message.ts;
      } else {
        // An ambiguous prior commit may have succeeded. Authenticate the
        // existing ciphertext before deleting the only durable replay copy.
        const existing = await rpc('suco_message_read', { p_object_id: id });
        if (!Array.isArray(existing) || existing.length !== 1) fail('INGESTION_SPOOL_REMOTE');
        cache.set(id, openRow(existing[0] as CipherRow));
      }
      await spool.ack(message.chat_jid, message.id);
      lastWriteSuccessAt = new Date();
      consecutiveWriteFailures = 0;
    } catch (error) {
      lastWriteFailureAt = new Date();
      consecutiveWriteFailures++;
      throw error;
    }
  }

  return {
    stage: (message) => spool.stage(message),
    commit,
    async ingest(message) { await spool.stage(message); await commit(message); },
    async replay(beforeEach) {
      ensureOpen();
      if (beforeEach && !(await beforeEach())) fail('INGESTION_SPOOL_AUTH');
      let count = 0;
      for await (const message of spool.pending()) {
        if (beforeEach && !(await beforeEach())) fail('INGESTION_SPOOL_AUTH');
        await commit(message);
        count++;
      }
      return count;
    },
    async snapshot() {
      await load();
      return [...cache.values()];
    },
    async evidence() {
      await load();
      let lastSavedMessageAt: Date | null = null;
      for (const message of cache.values()) {
        if (!lastSavedMessageAt || message.ts > lastSavedMessageAt) lastSavedMessageAt = message.ts;
      }
      return { lastIngestedAt, lastSavedMessageAt, lastCommittedMessageAt,
        writeHealth: { lastWriteSuccessAt, lastWriteFailureAt, consecutiveWriteFailures } };
    },
    async query(query = {}) {
      ensureOpen();
      if (query.from && (!(query.from instanceof Date) || !Number.isFinite(query.from.valueOf()))) fail('INGESTION_SPOOL_INPUT');
      if (query.before && (!(query.before instanceof Date) || !Number.isFinite(query.before.valueOf()))) fail('INGESTION_SPOOL_INPUT');
      if (query.chatJid !== undefined && typeof query.chatJid !== 'string') fail('INGESTION_SPOOL_INPUT');
      if (query.text !== undefined && typeof query.text !== 'string') fail('INGESTION_SPOOL_INPUT');
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000))
        fail('INGESTION_SPOOL_INPUT');
      await load();
      const text = query.text?.toLocaleLowerCase();
      return [...cache.values()]
        .filter((m) => (!query.chatJid || m.chat_jid === query.chatJid) &&
          (!query.from || m.ts >= query.from) && (!query.before || m.ts < query.before) &&
          (!text || (m.body ?? '').toLocaleLowerCase().includes(text)))
        .sort((a, b) => b.ts.valueOf() - a.ts.valueOf() || a.id.localeCompare(b.id))
        .slice(0, query.limit ?? 100);
    },
    async stats(chatJid) {
      ensureOpen();
      await load();
      const matches = [...cache.values()].filter((m) => m.chat_jid === chatJid);
      let first: Date | null = null;
      let last: Date | null = null;
      for (const m of matches) {
        if (!first || m.ts < first) first = m.ts;
        if (!last || m.ts > last) last = m.ts;
      }
      return { totalMessages: matches.length, firstMessageAt: first, lastMessageAt: last };
    },
    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      encKey.fill(0);
      nameKey.fill(0);
      spool.close();
    },
  };
}
