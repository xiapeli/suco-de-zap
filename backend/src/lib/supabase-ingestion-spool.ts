import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { IngestionSpool, StagedMessage } from './ingestion-spool.js';
import { IngestionSpoolError } from './ingestion-spool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = /^[A-Za-z0-9._-]{1,128}$/;
const HEX = /^[0-9a-f]+$/;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;

type ListRow = {
  object_id: string;
  key_epoch: number;
  nonce_hex: string;
  ciphertext_hex: string;
  revision: number;
};

export interface SupabaseSpoolOptions {
  /** URL and publishable key are public; never pass a service_role key. */
  url: string;
  publishableKey: string;
  ownerId: string;
  tenantId: string;
  keyEpoch: number;
  /** Released inside the verified worker only; never stored at Supabase. */
  key: Uint8Array;
  /** Must refresh and return this owner's Supabase Auth user JWT. */
  userJwt: () => Promise<string>;
  fetcher?: typeof fetch;
}

function fail(code: 'INGESTION_SPOOL_INPUT' | 'INGESTION_SPOOL_AUTH' |
  'INGESTION_SPOOL_REMOTE' | 'INGESTION_SPOOL_UNREADABLE'): never {
  throw new IngestionSpoolError(code);
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

function userToken(token: string, ownerId: string): boolean {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(Boolean)) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    return payload.role === 'authenticated' && payload.sub === ownerId &&
      typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000) + 5;
  } catch { return false; }
}

function opaqueUuid(bytes: Buffer): string {
  const id = Buffer.from(bytes.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x80; // UUIDv8 custom, from keyed digest.
  id[8] = (id[8] & 0x3f) | 0x80;
  const hex = id.toString('hex');
  id.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Remote outbox; Supabase receives only ciphertext, opaque UUIDs and metadata. */
export function createSupabaseIngestionSpool(options: SupabaseSpoolOptions): IngestionSpool {
  let endpoint: URL;
  try { endpoint = new URL(options.url); }
  catch { return fail('INGESTION_SPOOL_INPUT'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !UUID.test(options.ownerId) ||
      !TENANT.test(options.tenantId) ||
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
  const encKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-cloud-spool-v1:enc', 32));
  const nameKey = Buffer.from(hkdfSync('sha256', options.key, salt, 'suco-cloud-spool-v1:name', 32));
  const fetcher = options.fetcher ?? fetch;
  let closed = false;
  const ensureOpen = () => { if (closed) fail('INGESTION_SPOOL_INPUT'); };
  const objectId = (chatJid: string, messageId: string) => opaqueUuid(
    createHmac('sha256', nameKey).update(chatJid).update('\0').update(messageId).digest()
  );
  const aad = (id: string, epoch: number) => Buffer.from(
    `suco-cloud-spool-v1\0${options.tenantId}\0${options.ownerId}\0${id}\0${epoch}`, 'utf8'
  );

  async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    ensureOpen();
    for (let attempt = 0; attempt < 3; attempt++) {
      const jwt = await options.userJwt();
      if (!userToken(jwt, options.ownerId)) fail('INGESTION_SPOOL_AUTH');
      try {
        const response = await fetcher(`${base}/rest/v1/rpc/${name}`, {
          method: 'POST',
          headers: {
            apikey: options.publishableKey,
            Authorization: `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
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

  function seal(message: StagedMessage, id: string): { nonce: string; ciphertext: string } {
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

  function openRow(row: ListRow): StagedMessage {
    try {
      if (!UUID.test(row.object_id) || row.key_epoch !== options.keyEpoch || row.revision !== 1 ||
          typeof row.nonce_hex !== 'string' || !/^[0-9a-f]{24}$/.test(row.nonce_hex) ||
          typeof row.ciphertext_hex !== 'string' || !HEX.test(row.ciphertext_hex) ||
          row.ciphertext_hex.length < 64 || row.ciphertext_hex.length > MAX_CIPHERTEXT_BYTES * 2 ||
          row.ciphertext_hex.length % 2 !== 0) throw Error('shape');
      const sealed = Buffer.from(row.ciphertext_hex, 'hex');
      const tag = sealed.subarray(sealed.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(row.nonce_hex, 'hex'));
      decipher.setAAD(aad(row.object_id, row.key_epoch));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
      sealed.fill(0);
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

  return {
    async stage(message) {
      ensureOpen();
      if (!validMessage(message)) fail('INGESTION_SPOOL_INPUT');
      const id = objectId(message.chat_jid, message.id);
      const encrypted = seal(message, id);
      const revision = await rpc('suco_ingestion_stage', {
        p_object_id: id,
        p_key_epoch: options.keyEpoch,
        p_nonce_hex: encrypted.nonce,
        p_ciphertext_hex: encrypted.ciphertext,
      });
      if (revision !== 1) fail('INGESTION_SPOOL_REMOTE');
    },
    async *pending() {
      ensureOpen();
      let after: string | null = null;
      for (;;) {
        const result = await rpc('suco_ingestion_list', { p_after: after, p_limit: 100 });
        if (!Array.isArray(result) || result.length > 100) fail('INGESTION_SPOOL_REMOTE');
        for (const raw of result) {
          const row = raw as ListRow;
          yield openRow(row);
        }
        if (result.length < 100) return;
        after = (result[result.length - 1] as ListRow).object_id;
        if (!UUID.test(after)) fail('INGESTION_SPOOL_REMOTE');
      }
    },
    async ack(chatJid, messageId) {
      ensureOpen();
      if (!chatJid || !messageId) fail('INGESTION_SPOOL_INPUT');
      const result = await rpc('suco_ingestion_ack', {
        p_object_id: objectId(chatJid, messageId), p_expected_revision: 1,
      });
      if (result !== true) fail('INGESTION_SPOOL_REMOTE');
    },
    close() {
      if (closed) return;
      closed = true;
      encKey.fill(0);
      nameKey.fill(0);
    },
  };
}
