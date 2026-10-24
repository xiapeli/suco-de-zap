import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { MessageRow } from '../db.js';

const MAGIC = Buffer.from('SUCOMSG1');
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const FINAL_NAME = /^[a-f0-9]{64}\.msg$/;
const TEMP_NAME = /^\.([a-f0-9]{64})\.[a-f0-9]{16}\.tmp$/;

export type StagedMessage = Omit<MessageRow, 'seq'>;
export type SpoolCode =
  | 'INGESTION_SPOOL_INPUT'
  | 'INGESTION_SPOOL_UNSAFE'
  | 'INGESTION_SPOOL_UNREADABLE'
  | 'INGESTION_SPOOL_IO'
  | 'INGESTION_SPOOL_AUTH'
  | 'INGESTION_SPOOL_REMOTE';

export class IngestionSpoolError extends Error {
  constructor(readonly code: SpoolCode) {
    super(code);
    this.name = 'IngestionSpoolError';
  }
}

export interface IngestionSpool {
  /** Durable before the caller processes the message. Existing IDs remain immutable. */
  stage(message: StagedMessage): Promise<void>;
  /** Replay each unacknowledged message after a restart, without any plaintext filename. */
  pending(): AsyncIterable<StagedMessage>;
  /** Call only after the database write commits. Idempotent after an uncertain ack. */
  ack(chatJid: string, messageId: string): Promise<void>;
  /** Drop derived keys from this process; the runtime owns the original key. */
  close(): void;
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

function inputError(): never { throw new IngestionSpoolError('INGESTION_SPOOL_INPUT'); }

/**
 * The caller must be a verified confidential runtime with a user-held 32-byte
 * key. No environment variable or host-side attestation flag activates this.
 * Only ciphertext is written to the supplied private directory.
 */
export async function createIngestionSpool(args: {
  directory: string;
  tenantId: string;
  key: Uint8Array;
}): Promise<IngestionSpool> {
  if (!isAbsolute(args.directory) || resolve(args.directory) === '/' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(args.tenantId) ||
      !(args.key instanceof Uint8Array) || args.key.length !== 32) inputError();
  const directory = resolve(args.directory);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
      throw new IngestionSpoolError('INGESTION_SPOOL_UNSAFE');
    }
  } catch (error) {
    if (error instanceof IngestionSpoolError) throw error;
    throw new IngestionSpoolError('INGESTION_SPOOL_IO');
  }

  const salt = Buffer.from(args.tenantId, 'utf8');
  const encryptionKey = Buffer.from(hkdfSync('sha256', args.key, salt, 'suco-ingestion-spool-v1:enc', 32));
  const nameKey = Buffer.from(hkdfSync('sha256', args.key, salt, 'suco-ingestion-spool-v1:name', 32));
  let closed = false;
  const ensureOpen = () => { if (closed) inputError(); };
  const opaqueName = (chatJid: string, messageId: string) =>
    createHmac('sha256', nameKey).update(chatJid).update('\0').update(messageId).digest('hex');
  const aad = (hash: string) => Buffer.from(`suco-ingestion-spool-v1\0${args.tenantId}\0${hash}`, 'utf8');

  async function syncDirectory() {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  function encrypt(message: StagedMessage, hash: string): Buffer {
    const plaintext = Buffer.from(JSON.stringify({
      chat_jid: message.chat_jid,
      id: message.id,
      sender_jid: message.sender_jid,
      sender_name: message.sender_name,
      from_me: message.from_me,
      body: message.body,
      msg_type: message.msg_type,
      ts: message.ts.toISOString(),
    }), 'utf8');
    if (plaintext.length > MAX_RECORD_BYTES) { plaintext.fill(0); inputError(); }
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
      cipher.setAAD(aad(hash));
      const content = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), content]);
    } finally {
      plaintext.fill(0);
    }
  }

  async function readMessage(name: string, hash: string): Promise<StagedMessage> {
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let sealed: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size < 36 ||
          stat.size > MAX_RECORD_BYTES + 36) throw new IngestionSpoolError('INGESTION_SPOOL_UNREADABLE');
      sealed = await handle.readFile();
    } finally {
      await handle.close();
    }
    try {
      if (!sealed.subarray(0, 8).equals(MAGIC)) throw Error('format');
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, sealed.subarray(8, 20));
      decipher.setAAD(aad(hash));
      decipher.setAuthTag(sealed.subarray(20, 36));
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(36)), decipher.final()]);
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>; }
      finally { plaintext.fill(0); }
      const message = {
        chat_jid: parsed.chat_jid,
        id: parsed.id,
        sender_jid: parsed.sender_jid,
        sender_name: parsed.sender_name,
        from_me: parsed.from_me,
        body: parsed.body,
        msg_type: parsed.msg_type,
        ts: new Date(parsed.ts as string),
      };
      if (!validMessage(message) || opaqueName(message.chat_jid, message.id) !== hash) throw Error('identity');
      return message;
    } catch {
      throw new IngestionSpoolError('INGESTION_SPOOL_UNREADABLE');
    } finally {
      sealed.fill(0);
    }
  }

  async function recoverTemps() {
    for (const name of (await readdir(directory)).sort()) {
      const match = TEMP_NAME.exec(name);
      if (!match) continue;
      const hash = match[1];
      await readMessage(name, hash); // A partial or tampered stage stops replay.
      try {
        await link(join(directory, name), join(directory, `${hash}.msg`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await readMessage(`${hash}.msg`, hash);
      }
      await unlink(join(directory, name));
      await syncDirectory();
    }
  }

  return {
    async stage(message) {
      ensureOpen();
      if (!validMessage(message)) inputError();
      const hash = opaqueName(message.chat_jid, message.id);
      const temp = `.${hash}.${randomBytes(8).toString('hex')}.tmp`;
      const sealed = encrypt(message, hash);
      try {
        const handle = await open(join(directory, temp),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(sealed); await handle.sync(); }
        finally { await handle.close(); }
        try {
          await link(join(directory, temp), join(directory, `${hash}.msg`));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await readMessage(`${hash}.msg`, hash);
        }
        await unlink(join(directory, temp));
        await syncDirectory();
      } catch (error) {
        if (error instanceof IngestionSpoolError) throw error;
        throw new IngestionSpoolError('INGESTION_SPOOL_IO');
      } finally {
        sealed.fill(0);
      }
    },
    async *pending() {
      ensureOpen();
      try { await recoverTemps(); }
      catch (error) {
        if (error instanceof IngestionSpoolError) throw error;
        throw new IngestionSpoolError('INGESTION_SPOOL_IO');
      }
      for (const name of (await readdir(directory)).filter((n) => FINAL_NAME.test(n)).sort()) {
        ensureOpen();
        try { yield await readMessage(name, name.slice(0, 64)); }
        catch (error) {
          if (error instanceof IngestionSpoolError) throw error;
          throw new IngestionSpoolError('INGESTION_SPOOL_IO');
        }
      }
    },
    async ack(chatJid, messageId) {
      ensureOpen();
      if (!chatJid || !messageId) inputError();
      const file = join(directory, `${opaqueName(chatJid, messageId)}.msg`);
      try { await unlink(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new IngestionSpoolError('INGESTION_SPOOL_IO');
      }
      try { await syncDirectory(); }
      catch { throw new IngestionSpoolError('INGESTION_SPOOL_IO'); }
    },
    close() {
      if (closed) return;
      closed = true;
      encryptionKey.fill(0);
      nameKey.fill(0);
    },
  };
}
