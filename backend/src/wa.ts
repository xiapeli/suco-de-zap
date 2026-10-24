import { safeErrorCode } from './lib/request-validation.js';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  jidNormalizedUser,
  proto,
  USyncQuery,
  USyncUser,
  type WAMessage,
  type WAMessageKey,
  type Contact,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { SocksProxyAgent } from 'socks-proxy-agent';
import pino from 'pino';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { config } from './config.js';
import { authorizeTenant, authorizeIngestion, tenantAllowed } from './tenant-context.js';
import { upsertChat, upsertContact, upsertLidMap, insertMessage, pool } from './db.js';
import type { IngestionSpool, StagedMessage } from './lib/ingestion-spool.js';
import type { ConfidentialAuthAdapter } from './lib/confidential-auth-state.js';
import type { ConfidentialMessageStore } from './lib/confidential-message-store.js';
import type { ConfidentialMetadataStore } from './lib/confidential-metadata-store.js';
import type { AudioTranscriber } from './lib/confidential-audio.js';
import {
  ConnectionTracker,
  FencedTimer,
  QR_TTL_MS,
  type MeInfo,
  type PublicConnectionStatus,
} from './lib/connection-state.js';

const logger = pino({ level: 'warn' });

/**
 * Status público = snapshot do tracker e erro de identidade aditivo, sem JID.
 */
export type PairingErrorCode = 'PAIRING_ACCOUNT_MISMATCH' | 'PAIRING_IDENTITY_UNAVAILABLE';
export type WaStatus = PublicConnectionStatus & { pairingError: PairingErrorCode | null };

const tracker = new ConnectionTracker();
/** cache de "me" p/ o hot path do storeMessage */
let me: MeInfo | null = null;
let sock: ReturnType<typeof makeWASocket> | null = null;
let stopped = false;
const timerFns = {
  set: (fn, delayMs) => setTimeout(fn, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
} satisfies ConstructorParameters<typeof FencedTimer>[1];
const retryTimer = new FencedTimer(tracker, timerFns);
// Baileys may leave a socket in `connecting` without emitting either QR or
// close. Bound that attempt so the API never reports an endless spinner.
const progressTimer = new FencedTimer(tracker, timerFns);
const CONNECT_PROGRESS_TIMEOUT_MS = 45_000;
const QR_PROGRESS_GRACE_MS = 10_000;
/** mutex: nunca duas startWhatsApp em paralelo (socket único) */
let starting: Promise<void> | null = null;
let startingGeneration = 0;
let stopping: Promise<void> | null = null;
let credsWrite: Promise<void> = Promise.resolve();
let authKeys: Awaited<ReturnType<typeof useMultiFileAuthState>>['state']['keys'] | null = null;
let pairingFlight: Promise<WaStatus> | null = null;
let pairingRotating = false;
let pairingError: PairingErrorCode | null = null;
// A database outage must not discard a WhatsApp event while this process is
// alive. The confidential worker must add an encrypted, attested spool before
// this can be treated as crash-safe delivery.
const pendingMessages = new Map<string, WAMessage>();
const livePendingKeys = new Set<string>();
let pendingDrain: Promise<void> | null = null;
let pendingRetryHandle: ReturnType<typeof setTimeout> | null = null;
let pendingRetryDelay: number | null = null;
const PENDING_RETRY_MS = 5_000;
const PENDING_DRAIN_BATCH = 16;
export function getPendingIngestionCount(): number { return pendingMessages.size; }
let ingestionSpool: IngestionSpool | null = null;
let ingestionSpoolReady = false;
// The confidential Supabase outbox is durable only after stage() succeeds.
// Events waiting in pendingMessages because the first remote write failed are
// process-local and will be lost on a crash. Do not report crash-safe recovery.
export function hasDurableIngestionSpool(): boolean { return ingestionSpoolReady; }
let confidentialAuth: ConfidentialAuthAdapter | null = null;
let confidentialAuthorize: (() => Promise<boolean>) | null = null;
let confidentialMessages: ConfidentialMessageStore | null = null;
let confidentialMessagesReady = false;
let confidentialMetadata: ConfidentialMetadataStore | null = null;
let confidentialMetadataReady = false;
/** Voice-note transcription inside the TEE; null on the legacy worker. */
let confidentialTranscriber: AudioTranscriber | null = null;
export function getConfidentialMessageStore(): ConfidentialMessageStore | null {
  return confidentialMessagesReady ? confidentialMessages : null;
}
export function getConfidentialMetadataStore(): ConfidentialMetadataStore | null {
  return confidentialMetadataReady ? confidentialMetadata : null;
}

/** Explicitly called by the attested worker bootstrap; the legacy worker never calls this. */
export function installConfidentialAuth(
  adapter: ConfidentialAuthAdapter,
  authorize: () => Promise<boolean>,
  pairingPolicy: 'existing-bound' | 'new-account',
): void {
  if (!config.confidentialRuntime || confidentialAuth || ingestionSpool || !adapter || typeof authorize !== 'function' ||
      !['existing-bound', 'new-account'].includes(pairingPolicy) ||
      tracker.currentGeneration !== 0 || sock || starting || pairingRotating) {
    throw new Error('CONFIDENTIAL_AUTH_INSTALL_UNSAFE');
  }
  if (pairingPolicy === 'existing-bound' && !adapter.hasImportedLegacyIdentity())
    throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
  confidentialAuth = adapter;
  confidentialAuthorize = authorize;
}

export function confidentialModeEnabled(): boolean { return confidentialAuth !== null; }

async function authorizeActiveIngestion(): Promise<boolean> {
  if (!confidentialAuth) return authorizeIngestion();
  if (!confidentialAuthorize) return false;
  try { return await confidentialAuthorize() === true; }
  catch { return false; }
}

/** Install only after attestation, key release, owner JWT and encrypted auth. */
export async function installConfidentialMessageStore(store: ConfidentialMessageStore): Promise<void> {
  if (!confidentialAuth || !store || confidentialMessages || ingestionSpool ||
      tracker.currentGeneration !== 0 || starting || sock)
    throw new Error('CONFIDENTIAL_MESSAGES_INSTALL_UNSAFE');
  confidentialMessages = store;
  if (!(await authorizeActiveIngestion())) throw new Error('CONFIDENTIAL_MESSAGES_NOT_AUTHORIZED');
  await store.replay(() => authorizeActiveIngestion());
  if (!(await authorizeActiveIngestion())) throw new Error('CONFIDENTIAL_MESSAGES_NOT_AUTHORIZED');
  confidentialMessagesReady = true;
}

/** Install only in the attested worker; voice notes stay "[audio]" elsewhere. */
export function installConfidentialTranscriber(transcriber: AudioTranscriber): void {
  if (!confidentialAuth || confidentialTranscriber || typeof transcriber !== 'function' ||
      tracker.currentGeneration !== 0 || starting || sock)
    throw new Error('CONFIDENTIAL_TRANSCRIBER_INSTALL_UNSAFE');
  confidentialTranscriber = transcriber;
}

export async function installConfidentialMetadataStore(store: ConfidentialMetadataStore): Promise<void> {
  if (!confidentialAuth || !store || confidentialMetadata || tracker.currentGeneration !== 0 || starting || sock)
    throw new Error('CONFIDENTIAL_METADATA_INSTALL_UNSAFE');
  confidentialMetadata = store;
  if (!(await authorizeActiveIngestion())) throw new Error('CONFIDENTIAL_METADATA_NOT_AUTHORIZED');
  await store.load();
  if (!(await authorizeActiveIngestion())) throw new Error('CONFIDENTIAL_METADATA_NOT_AUTHORIZED');
  confidentialMetadataReady = true;
}

/** Call from a verified confidential bootstrap, after database init and before WA start. */
export async function installIngestionSpool(spool: IngestionSpool): Promise<void> {
  if (ingestionSpool || confidentialAuth || confidentialMessages || tracker.currentGeneration !== 0 || starting || sock)
    throw new Error('INGESTION_SPOOL_INSTALL_ORDER');
  ingestionSpool = spool;
  try {
    if (!(await authorizeIngestion())) throw new Error('INGESTION_SPOOL_NOT_AUTHORIZED');
    for await (const row of spool.pending()) {
      if (!(await authorizeIngestion())) throw new Error('INGESTION_SPOOL_NOT_AUTHORIZED');
      await upsertChat(row.chat_jid, null, row.chat_jid.endsWith('@g.us'));
      if (!(await authorizeIngestion())) throw new Error('INGESTION_SPOOL_NOT_AUTHORIZED');
      await insertMessage(row);
      await spool.ack(row.chat_jid, row.id);
    }
    ingestionSpoolReady = true;
  } catch (error) {
    // A failed replay must fail startup; its sealed records remain for retry.
    throw error;
  }
}

interface IdentityLock { version: 1; salt: string; digest: string }

function identityError(code: PairingErrorCode): Error & { code: PairingErrorCode } {
  return Object.assign(new Error(code), { code });
}

function normalizedAccountJid(raw: string | null | undefined): string | null {
  const jid = typeof raw === 'string' ? jidNormalizedUser(raw.trim()) : '';
  return /^\d{5,20}@s\.whatsapp\.net$/.test(jid) ? jid : null;
}

function identityLockPath(authDir: string): string { return `${authDir}.identity-lock.json`; }

function readIdentityLock(authDir: string): IdentityLock | null {
  const path = identityLockPath(authDir);
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 1024)
    throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<IdentityLock>;
    if (record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.salt || '') || !/^[a-f0-9]{64}$/.test(record.digest || ''))
      throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
    return record as IdentityLock;
  } catch {
    throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
  }
}

function identityMatches(lock: IdentityLock, raw: string | null | undefined): boolean {
  const jid = normalizedAccountJid(raw);
  if (!jid) return false;
  const digest = scryptSync(jid, Buffer.from(lock.salt, 'hex'), 32);
  return timingSafeEqual(digest, Buffer.from(lock.digest, 'hex'));
}

function establishIdentityLock(authDir: string, raw: string | null | undefined): IdentityLock {
  const jid = normalizedAccountJid(raw);
  if (!jid) throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
  const existing = readIdentityLock(authDir);
  if (existing) {
    if (!identityMatches(existing, jid)) throw identityError('PAIRING_ACCOUNT_MISMATCH');
    return existing;
  }
  const salt = randomBytes(16).toString('hex');
  const record: IdentityLock = { version: 1, salt, digest: scryptSync(jid, Buffer.from(salt, 'hex'), 32).toString('hex') };
  try {
    writeFileSync(identityLockPath(authDir), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
    const raced = readIdentityLock(authDir);
    if (!raced || !identityMatches(raced, jid)) throw identityError('PAIRING_ACCOUNT_MISMATCH');
    return raced;
  }
}

/**
 * Formata o número de um JID (@s.whatsapp.net) de forma legível.
 * Ex.: 5511999998888@s.whatsapp.net -> "+55 11 99999-8888". Retorna null se não parecer número.
 */
export function formatPhoneFromJid(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0];
  // LIDs têm 13-15 dígitos mas não são números discáveis; só formata JIDs de telefone.
  if (!jid.includes('@s.whatsapp.net') || !/^\d{8,15}$/.test(digits)) return null;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const cut = rest.length - 4;
    return `+55 ${ddd} ${rest.slice(0, cut)}-${rest.slice(cut)}`;
  }
  return `+${digits}`;
}

export function getStatus(): WaStatus {
  const status = tracker.snapshot();
  if (!pairingError) return { ...status, pairingError: null };
  return {
    ...status,
    connected: false,
    qr: null,
    me: null,
    connectionState: 'action_required',
    reason: null,
    actionHint: pairingError === 'PAIRING_ACCOUNT_MISMATCH'
      ? 'Este WhatsApp é diferente do já vinculado. Leia o QR com o mesmo WhatsApp da conta.'
      : 'Não foi possível confirmar qual WhatsApp pertence a esta conta. A sessão anterior foi preservada.',
    pairingError,
  };
}

function isIgnorableJid(jid: string | null | undefined): boolean {
  if (!jid) return true;
  return (
    jid === 'status@broadcast' ||
    jid.endsWith('@broadcast') ||
    jid.endsWith('@newsletter')
  );
}

function unwrap(message: proto.IMessage | null | undefined): proto.IMessage | null {
  if (!message) return null;
  if (message.ephemeralMessage?.message) return unwrap(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return unwrap(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return unwrap(message.viewOnceMessageV2.message);
  if (message.viewOnceMessageV2Extension?.message) return unwrap(message.viewOnceMessageV2Extension.message);
  if (message.documentWithCaptionMessage?.message) return unwrap(message.documentWithCaptionMessage.message);
  if (message.editedMessage?.message?.protocolMessage?.editedMessage)
    return unwrap(message.editedMessage.message.protocolMessage.editedMessage);
  return message;
}

function extractContent(raw: proto.IMessage | null | undefined): { type: string; body: string | null } | null {
  const m = unwrap(raw);
  if (!m) return null;
  if (m.conversation) return { type: 'text', body: m.conversation };
  if (m.extendedTextMessage?.text) return { type: 'text', body: m.extendedTextMessage.text };
  if (m.imageMessage) return { type: 'image', body: m.imageMessage.caption || null };
  if (m.videoMessage) return { type: 'video', body: m.videoMessage.caption || null };
  if (m.audioMessage) return { type: 'audio', body: null };
  if (m.stickerMessage) return { type: 'sticker', body: null };
  if (m.documentMessage)
    return { type: 'document', body: m.documentMessage.caption || m.documentMessage.fileName || null };
  if (m.locationMessage)
    return { type: 'location', body: m.locationMessage.name || m.locationMessage.address || null };
  if (m.contactMessage) return { type: 'contact', body: m.contactMessage.displayName || null };
  if (m.contactsArrayMessage) return { type: 'contact', body: m.contactsArrayMessage.displayName || null };
  if (m.pollCreationMessage) return { type: 'poll', body: m.pollCreationMessage.name || null };
  if (m.pollCreationMessageV2) return { type: 'poll', body: m.pollCreationMessageV2.name || null };
  if (m.pollCreationMessageV3) return { type: 'poll', body: m.pollCreationMessageV3.name || null };
  if (m.reactionMessage) return { type: 'reaction', body: m.reactionMessage.text || null };
  if (m.liveLocationMessage) return { type: 'location', body: null };
  if (m.protocolMessage || m.senderKeyDistributionMessage) return null;
  return { type: 'other', body: null };
}

function toDate(ts: number | Long | null | undefined): Date {
  const n = typeof ts === 'number' ? ts : ts ? Number(ts) : 0;
  return new Date((n || Math.floor(Date.now() / 1000)) * 1000);
}

async function allowedAttempt(isLive:()=>boolean):Promise<boolean> {
  if (!isLive()) return false;
  if (confidentialAuth) return await authorizeActiveIngestion() && isLive();
  return await authorizeTenant() && isLive() && tenantAllowed();
}

/**
 * Voice notes are downloaded, transcribed inside the TEE and reduced to text
 * before staging; any failure keeps the plain "[audio]" body so ingestion of
 * the message itself never depends on the provider.
 */
async function transcribeAudioNote(m: WAMessage, isLive: () => boolean): Promise<string | null> {
  if (!confidentialTranscriber) return null;
  try {
    const audio = unwrap(m.message)?.audioMessage;
    const seconds = typeof audio?.seconds === 'number' ? audio.seconds : 0;
    if (!audio || seconds <= 0) return null;
    if (!isLive()) return null;
    const bytes = await downloadMediaMessage(m, 'buffer', {},
      { reuploadRequest: msg => sock!.updateMediaMessage(msg), logger });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return null;
    if (!isLive()) return null;
    const transcript = await confidentialTranscriber({
      bytes, mime: audio.mimetype || 'audio/ogg; codecs=opus', durationMs: seconds * 1000,
    });
    const text = typeof transcript === 'string' ? transcript.trim() : '';
    if (!text || text.length > 8_000) return null;
    return `[áudio] ${text}`;
  } catch {
    return null;
  }
}

async function storeMessage(m: WAMessage, isLive:()=>boolean): Promise<boolean> {
  if (!(await allowedAttempt(isLive))) return false;
  const chatJid = m.key?.remoteJid;
  if (isIgnorableJid(chatJid) || !m.key?.id) return true;
  const content = extractContent(m.message);
  if (!content) return true;

  const isGroup = chatJid!.endsWith('@g.us');
  const fromMe = !!m.key.fromMe;
  const senderJid = isGroup ? m.key.participant || m.participant || null : fromMe ? me?.jid || null : chatJid!;
  const senderName = fromMe ? me?.name || 'Eu' : m.pushName || null;
  const ts = toDate(m.messageTimestamp as number | Long | null | undefined);
  const audioTranscript = content.type === 'audio' ? await transcribeAudioNote(m, isLive) : null;
  const row: StagedMessage = {
    chat_jid: chatJid!, id: m.key.id, sender_jid: senderJid,
    sender_name: senderName, from_me: fromMe, body: audioTranscript ?? content.body,
    msg_type: content.type, ts,
  };

  if (confidentialMessages) {
    if (!confidentialMessagesReady) throw new Error('CONFIDENTIAL_MESSAGES_NOT_READY');
    if (!confidentialMetadataReady || !confidentialMetadata) throw new Error('CONFIDENTIAL_METADATA_NOT_READY');
    await confidentialMessages.stage(row);
    if (!(await allowedAttempt(isLive))) return false;
    await confidentialMessages.commit(row);
    if (!(await allowedAttempt(isLive))) return true;
    await confidentialMetadata.putChat(chatJid!, null, isGroup);
    if (senderJid && senderName && !fromMe) {
      if (!(await allowedAttempt(isLive))) return true;
      await confidentialMetadata.putContact(senderJid, { name: null, notify: senderName });
    }
    const key = m.key as WAMessageKey;
    if (!isGroup && !fromMe && chatJid!.endsWith('@lid') && key.senderPn) {
      if (!(await allowedAttempt(isLive))) return true;
      await confidentialMetadata.putLidMap(chatJid!, key.senderPn);
      if (senderName) await confidentialMetadata.putContact(key.senderPn, { name: null, notify: senderName });
    }
    if (isGroup && senderJid?.endsWith('@lid') && key.participantPn) {
      if (!(await allowedAttempt(isLive))) return true;
      await confidentialMetadata.putLidMap(senderJid, key.participantPn);
      if (senderName && !fromMe) await confidentialMetadata.putContact(key.participantPn, { name: null, notify: senderName });
    }
    return true;
  }

  if (ingestionSpool) {
    if (!ingestionSpoolReady) throw new Error('INGESTION_SPOOL_NOT_READY');
    await ingestionSpool.stage(row);
    if (!(await allowedAttempt(isLive))) return false;
  }

  // The chat row is required by wa_messages' FK. Its last_message_at is
  // advanced by an AFTER INSERT trigger only when the message commit succeeds.
  await upsertChat(chatJid!, null, isGroup);
  if (!(await allowedAttempt(isLive))) return false;
  await insertMessage(row);
  if (ingestionSpool) await ingestionSpool.ack(row.chat_jid, row.id);
  if (!(await allowedAttempt(isLive))) return true;
  if (senderJid && senderName && !fromMe) {
    try { await upsertContact(senderJid, { notify: senderName }); }
    catch (error) { console.error('Erro ao salvar contato após mensagem:', safeErrorCode(error)); }
  }

  // Mapeamento LID -> número real: o WhatsApp manda o alt "sender_pn"/"participant_pn"
  // nos atributos da stanza quando o remetente usa o identificador oculto (@lid).
  const key = m.key as WAMessageKey;
  try {
    if (!isGroup && !fromMe && chatJid!.endsWith('@lid') && key.senderPn) {
      if (!(await allowedAttempt(isLive))) return true;
      await upsertLidMap(chatJid!, key.senderPn);
      if (!(await allowedAttempt(isLive))) return true;
      if (senderName) await upsertContact(key.senderPn, { notify: senderName });
    }
    if (isGroup && senderJid?.endsWith('@lid') && key.participantPn) {
      if (!(await allowedAttempt(isLive))) return true;
      await upsertLidMap(senderJid, key.participantPn);
      if (!(await allowedAttempt(isLive))) return true;
      if (senderName && !fromMe) await upsertContact(key.participantPn, { notify: senderName });
    }
  } catch (e) {
    console.error('Erro ao gravar mapeamento LID:', safeErrorCode(e));
  }
  return true;
}

function pendingMessageKey(m: WAMessage): string | null {
  const jid = m.key?.remoteJid, id = m.key?.id;
  return jid && id ? `${jid}\0${id}` : null;
}

function schedulePendingMessages(isLive: () => boolean, delayMs = PENDING_RETRY_MS) {
  if (!pendingMessages.size || !isLive()) return;
  // History failures must not keep postponing a scheduled retry. A new live
  // failure may, however, bring the next drain forward.
  if (pendingRetryHandle && pendingRetryDelay !== null && pendingRetryDelay <= delayMs) return;
  if (pendingRetryHandle) clearTimeout(pendingRetryHandle);
  pendingRetryDelay = delayMs;
  pendingRetryHandle = setTimeout(() => {
    pendingRetryHandle = null;
    pendingRetryDelay = null;
    void drainPendingMessages(isLive);
  }, delayMs);
}

async function drainPendingMessages(isLive: () => boolean) {
  if (pendingDrain) {
    await pendingDrain;
    schedulePendingMessages(isLive);
    return;
  }
  let progressed = false;
  pendingDrain = (async () => {
    const attempted = new Set<string>();
    while (attempted.size < PENDING_DRAIN_BATCH) {
      // Re-evaluate after every remote write: a live event can arrive while a
      // history retry is awaiting Supabase, and must be the next attempt.
      const key = [...livePendingKeys].find(item => pendingMessages.has(item) && !attempted.has(item)) ??
        [...pendingMessages.keys()].find(item => !attempted.has(item));
      if (!key) break;
      attempted.add(key);
      const message = pendingMessages.get(key);
      if (!message) continue;
      if (!isLive()) return;
      try {
        const saved = await storeMessage(message, isLive);
        if (saved && isLive() && pendingMessages.get(key) === message) {
          pendingMessages.delete(key);
          livePendingKeys.delete(key);
          progressed = true;
        }
      } catch (error) {
        console.error('Falha ao recuperar gravação de mensagem:', safeErrorCode(error));
        // Keep the failed entry and retry later; continue with other messages.
      }
    }
  })();
  try { await pendingDrain; }
  finally {
    pendingDrain = null;
    schedulePendingMessages(isLive, progressed ? 0 : PENDING_RETRY_MS);
  }
}

function retryFailedMessage(message: WAMessage, isLive: () => boolean, livePriority = false) {
  if (!isLive()) return;
  const key = pendingMessageKey(message);
  if (!key) return;
  pendingMessages.set(key, message);
  if (livePriority) livePendingKeys.add(key);
  schedulePendingMessages(isLive, livePriority ? 0 : PENDING_RETRY_MS);
}

/**
 * Processa contatos vindos do Baileys (history sync, app state sync, upserts).
 * Grava nome/pushName sob todos os JIDs conhecidos (id, jid, lid) e o mapeamento LID->número.
 */
async function handleContacts(contacts: Partial<Contact>[], isLive:()=>boolean) {
  if (confidentialMessages) {
    if (!confidentialMetadataReady || !confidentialMetadata) throw new Error('CONFIDENTIAL_METADATA_NOT_READY');
    for (const ct of contacts) {
      if (!ct.id) continue;
      const ids = new Set([ct.id, ct.jid, ct.lid].filter((x): x is string => !!x));
      for (const id of ids) {
        if (!(await allowedAttempt(isLive))) return;
        await confidentialMetadata.putContact(id, { name: ct.name || null, notify: ct.notify || null });
      }
      const lid = ct.lid || (ct.id.endsWith('@lid') ? ct.id : null);
      const pn = ct.jid || (ct.id.endsWith('@s.whatsapp.net') ? ct.id : null);
      if (lid && pn && await allowedAttempt(isLive)) await confidentialMetadata.putLidMap(lid, pn);
    }
    return;
  }
  for (const ct of contacts) {
    if (!ct.id) continue;
    try {
      const ids = new Set([ct.id, ct.jid, ct.lid].filter((x): x is string => !!x));
      for (const id of ids) {
        if (!(await allowedAttempt(isLive))) return;
        await upsertContact(id, { name: ct.name || null, notify: ct.notify || null });
      }
      const lid = ct.lid || (ct.id.endsWith('@lid') ? ct.id : null);
      const pn = ct.jid || (ct.id.endsWith('@s.whatsapp.net') ? ct.id : null);
      if (!(await allowedAttempt(isLive))) return;
      if (lid && pn) await upsertLidMap(lid, pn);
    } catch (e) {
      console.error('Erro ao gravar contato:', safeErrorCode(e));
    }
  }
}

export async function startWhatsApp(): Promise<void> {
  // A fresh pairing owns the auth directory until rotation finishes. The
  // pairing operation starts its own socket afterwards; keepers must not open
  // the old state while its backup is being prepared.
  if (pairingRotating || pairingError) return;
  if (confidentialAuth && (!confidentialMessagesReady || !confidentialMetadataReady))
    throw new Error('CONFIDENTIAL_STORES_NOT_READY');
  if (ingestionSpool && !ingestionSpoolReady) throw new Error('INGESTION_SPOOL_NOT_READY');
  const requestedGeneration = tracker.currentGeneration;
  if (stopping) {
    await stopping;
    if (tracker.currentGeneration !== requestedGeneration) return;
    return startWhatsApp();
  }
  if (starting) {
    if (!stopped && tracker.isCurrent(startingGeneration)) return starting;
    await starting;
    if (tracker.currentGeneration !== requestedGeneration) return;
    return startWhatsApp();
  }
  starting = startWhatsAppInner()
    .catch((e) => {
      console.error('Falha ao iniciar conexão WhatsApp:', safeErrorCode(e));
    })
    .finally(() => {
      starting = null;
    });
  startingGeneration = tracker.currentGeneration;
  return starting;
}

async function startWhatsAppInner() {
  stopped = false;
  retryTimer.clear();
  progressTimer.clear();
  // Geração nova ANTES de qualquer await: um logout que ocorra durante os
  // awaits abaixo chama markStopped() (que INVALIDA a geração) — esta
  // tentativa morre no próximo recheck em vez de criar socket após o stop.
  const gen = tracker.beginAttempt();
  // Socket liveness is separate from the short-lived entitlement cache. The
  // keeper refreshes that cache every 20s, while its TTL is 30s; using the
  // cache as a liveness fence silently drops events during the refresh gap.
  const attemptLive = () => !stopped && tracker.isCurrent(gen);
  const allowed = await allowedAttempt(attemptLive);
  if(!allowed){if(attemptLive())pauseWhatsApp();return;}
  if(!attemptLive())return;
  await credsWrite;
  if(!attemptLive())return;

  // Socket único: encerra (e desarma) qualquer socket anterior antes de criar outro.
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
    } catch {}
    try {
      sock.end(undefined);
    } catch {}
    sock = null;
  }

  const { state, saveCreds } = await (confidentialAuth
    ? confidentialAuth.load()
    : useMultiFileAuthState(config.authDir)).catch((e) => {
    if (attemptLive()) {
      if (confidentialAuth) pauseWhatsApp();
      else failAttempt(gen, e, 'ler estado de autenticação');
    }
    throw e; // startWhatsApp() já loga; estado/retry ficaram explícitos acima
  });
  if (!attemptLive()) return; // logout/restart durante o await
  let identityLock: IdentityLock | null = null;
  try {
    if (!confidentialAuth) identityLock = readIdentityLock(resolve(config.authDir));
  } catch {
    pauseWhatsApp();
    pairingError = 'PAIRING_IDENTITY_UNAVAILABLE';
    return;
  }
  const priorJid = state.creds?.me?.id;
  if (!(confidentialAuth ? confidentialAuth.hasIdentity() : identityLock) && priorJid) {
    try {
      if (confidentialAuth) await confidentialAuth.assertOrEstablishIdentity(priorJid);
      else identityLock = establishIdentityLock(resolve(config.authDir), priorJid);
    }
    catch (error) {
      pauseWhatsApp();
      const code = (error as { code?: string }).code;
      if (code === 'PAIRING_ACCOUNT_MISMATCH' || code === 'PAIRING_IDENTITY_UNAVAILABLE') pairingError = code;
      else console.error('Falha ao verificar autenticação cifrada:', safeErrorCode(error));
      return;
    }
  }
  if ((confidentialAuth ? confidentialAuth.hasIdentity() : Boolean(identityLock)) && priorJid &&
      !(confidentialAuth ? confidentialAuth.identityMatches(priorJid) : identityLock && identityMatches(identityLock, priorJid))) {
    pauseWhatsApp();
    pairingError = 'PAIRING_ACCOUNT_MISMATCH';
    return;
  }
  let identityVerified = Boolean(priorJid && (confidentialAuth
    ? confidentialAuth.identityMatches(priorJid)
    : identityLock && identityMatches(identityLock, priorJid)));
  let socketIdentityOpen = false;
  // Signal-key writes can also outlive a socket. Serialize them with saveCreds
  // so logout cleanup drains ALL authentication writes before removing files.
  const setKeys=state.keys.set.bind(state.keys);
  state.keys.set=(data)=>{
    const write=credsWrite.then(async()=>{if(attemptLive()&&authKeys===state.keys)await setKeys(data);});
    credsWrite=write.catch((error)=>{
      console.error('Não foi possível salvar as chaves de conexão:', safeErrorCode(error));
      if (confidentialAuth) pauseWhatsApp();
    });
    return write;
  };
  authKeys = state.keys;

  const agent = config.waProxy ? new SocksProxyAgent(config.waProxy) : undefined;
  if (agent) console.log('Socket do WhatsApp usando o proxy configurado.');

  // Busca a versão atual do WA (pelo proxy, se houver). Versão desatualizada = WhatsApp
  // derruba a conexão logo após o handshake (428).
  let version: Awaited<ReturnType<typeof fetchLatestBaileysVersion>>['version'];
  try {
    const fetched = await fetchLatestBaileysVersion(
      agent ? { httpsAgent: agent, proxy: false, timeout: 10_000 } : { timeout: 10_000 }
    );
    if (!attemptLive()) return; // NUNCA revalida stopped=false aqui
    version = fetched.version;
    if (!fetched.isLatest) {
      console.warn('⚠️ Não consegui buscar a versão mais recente do WA — usando fallback embutido.');
    }
  } catch (e: any) {
    // Erro de startup vira estado EXPLÍCITO + retry cercado (backoff/fencing) —
    // não fica 'connecting' eterno nem gera storm de tentativas.
    if (!attemptLive()) return;
    failAttempt(gen, e, 'buscar versão do WA');
    return;
  }

  // Long auth/version requests may outlive the cached authorization.
  if (!(await allowedAttempt(attemptLive))) {
    if (attemptLive()) pauseWhatsApp();
    return;
  }
  const s = makeWASocket({
    version,
    auth: state,
    logger,
    // ubuntu + syncFullHistory: combinação que o WA aceita no registro (macOS/windows
    // com syncFullHistory derrubam a conexão com 428 nesta versão do WA Web).
    browser: Browsers.ubuntu('Desktop'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    // Baileys defaults to 60s for the first QR and 20s afterwards. Keep its
    // rotation equal to the lifetime exposed by ConnectionTracker.
    qrTimeout: QR_TTL_MS,
    ...(agent ? ({ agent, fetchAgent: agent } as object) : {}),
  });
  if (!attemptLive()) {
    // logout bateu entre o último recheck e a criação do socket: descarta já.
    try {
      s.end(undefined);
    } catch {}
    return;
  }
  sock = s;
  // Fencing de eventos: só este socket, desta geração, sem stop pendente,
  // pode gravar no banco. Após QR novo, espera a identidade ser verificada.
  const socketLive = () => s === sock && tracker.isCurrent(gen) && !stopped;
  const isLive = () => socketLive() && identityVerified && (!confidentialAuth || socketIdentityOpen);
  const bufferUntilIdentityOpen = (message: WAMessage, livePriority = false) => {
    if (!confidentialAuth || !socketLive() || socketIdentityOpen) return;
    const key = pendingMessageKey(message);
    if (key) {
      pendingMessages.set(key, message);
      if (livePriority) livePendingKeys.add(key);
    }
  };
  const rejectIdentity = (code: PairingErrorCode) => {
    if (!socketLive()) return;
    pauseWhatsApp();
    pairingError = code;
    console.warn('Pareamento WhatsApp recusado por identidade da conta.');
  };
  const rejectAuthFailure = (error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === 'PAIRING_ACCOUNT_MISMATCH' || code === 'PAIRING_IDENTITY_UNAVAILABLE') {
      rejectIdentity(code);
    } else {
      console.error('Falha ao persistir autenticação cifrada:', safeErrorCode(error));
      if (confidentialAuth) pauseWhatsApp();
      else rejectIdentity('PAIRING_IDENTITY_UNAVAILABLE');
    }
  };

  const armProgressTimer = (delayMs: number) => progressTimer.schedule(gen, () => {
    if (!socketLive()) return;
    // Close and fence the silent socket before retrying. Never remove auth
    // files here: a stalled handshake is not a confirmed WhatsApp logout.
    sock = null;
    authKeys = null;
    me = null;
    try { s.ev.removeAllListeners('connection.update'); s.ev.removeAllListeners('creds.update'); } catch {}
    try { s.end(undefined); } catch {}
    const decision = tracker.markDisconnected(gen, 408);
    console.warn('Conexão WhatsApp sem progresso; nova tentativa agendada.');
    retryTimer.schedule(gen, () => {
      startWhatsApp().catch((e) => console.error('Falha ao reconectar:', safeErrorCode(e)));
    }, decision.delayMs);
  }, delayMs);

  armProgressTimer(CONNECT_PROGRESS_TIMEOUT_MS);

  s.ev.on('creds.update', () => {
    if(!socketLive())return;
    // Enter the drain queue synchronously: rotation/logout must wait even if
    // the identity check or authorization is still pending.
    const write=credsWrite.then(async()=>{
      if (!(await allowedAttempt(socketLive))) return;
      const candidate = state.creds?.me?.id;
      if (candidate) {
        try {
          if (confidentialAuth) await confidentialAuth.assertOrEstablishIdentity(candidate);
          else identityLock = establishIdentityLock(resolve(config.authDir), candidate);
        } catch (error) { rejectAuthFailure(error); return; }
        if (!socketLive()) return;
        identityVerified = true;
      }
      if (socketLive()) await saveCreds();
    });
    credsWrite=write.catch((error)=>{
      console.error('Não foi possível salvar o estado de conexão:', safeErrorCode(error));
      if (confidentialAuth) pauseWhatsApp();
    });
  });

  s.ev.on('connection.update', async (update) => {
    if (!socketLive()) return;
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // QR NÃO vai para o terminal/logs (é segredo de pareamento): quem está
      // autenticado lê via GET /api/status.
      tracker.markQr(gen, qr);
      armProgressTimer(QR_TTL_MS + QR_PROGRESS_GRACE_MS);
      console.log('📱 QR de pareamento disponível via GET /api/status (expira em ~60s).');
    }
    if (connection === 'open') {
      const candidate = s.user?.id || state.creds?.me?.id;
      const verification = credsWrite.then(async () => {
        if (!(await allowedAttempt(socketLive))) return false;
        if (confidentialAuth) await confidentialAuth.assertOrEstablishIdentity(candidate);
        else identityLock = establishIdentityLock(resolve(config.authDir), candidate);
        if (!socketLive()) return false;
        // An open socket is not healthy until the encrypted credentials are durable.
        if (confidentialAuth) await saveCreds();
        return socketLive();
      });
      credsWrite = verification.then(() => undefined).catch(rejectAuthFailure);
      const verified = await verification.catch(() => false);
      if (!verified || !socketLive()) return;
      identityVerified = true;
      socketIdentityOpen = true;
      pairingError = null;
      progressTimer.clear();
      const meJid = s.user?.id || null;
      me = meJid ? { jid: meJid, name: s.user?.name || null } : null;
      tracker.markConnected(gen, me);
      console.log('✅ WhatsApp conectado.');
      schedulePendingMessages(isLive, 0);
      // Nomes dos grupos não vêm no history sync — busca os subjects direto.
      // Timers guardados pela geração: tentativa velha não dispara sync.
      setTimeout(() => {
        if (isLive()) syncGroupNames().catch((e) => console.error('Erro ao buscar nomes de grupos:', safeErrorCode(e)));
      }, 5_000);
      // Nomes da agenda vêm pelo app state sync (contactAction) — força resync se necessário.
      setTimeout(() => {
        if (isLive()) syncContacts().catch((e) => console.error('Erro ao sincronizar contatos:', safeErrorCode(e)));
      }, 10_000);
    }
    if (connection === 'close') {
      progressTimer.clear();
      const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const decision = tracker.markDisconnected(gen, code);
      // A closed socket cannot ingest or persist credentials, including a late401.
      sock=null;authKeys=null;me=null;
      try{s.ev.removeAllListeners('creds.update');}catch{}
      try{s.end(undefined);}catch{}
      // Credenciais só são apagadas em logout CONFIRMADO (401 loggedOut) —
      // nunca em queda transitória, badSession, forbidden etc.
      if (decision.mayDeleteCreds) {
        console.log('⚠️ Sessão encerrada no WhatsApp (logout 401 confirmado). Limpando credenciais.');
        // Drain an already-started credential write BEFORE deleting; otherwise
        // saveCreds may recreate old credentials after confirmed logout.
        stopping=credsWrite.then(async()=>{
          if (confidentialAuth) await confidentialAuth.clearCurrent();
          else { try { rmSync(config.authDir,{recursive:true,force:true}); } catch {} }
        }).catch((error)=>console.error('Não foi possível limpar a sessão encerrada:',safeErrorCode(error)))
          .finally(()=>{stopping=null;});
      }
      if (!decision.autoRetry) {
        console.log(
          `⛔ Reconexão automática bloqueada (${decision.reason}) — ação do usuário necessária: ${decision.actionHint}`
        );
        return;
      }
      console.log(`🔁 Conexão caiu (${decision.reason}); nova tentativa em ${Math.round(decision.delayMs / 1000)}s.`);
      if (!stopped) {
        // FencedTimer: no máximo UM retry pendente; geração nova cancela este.
        retryTimer.schedule(
          gen,
          () => {
            startWhatsApp().catch((e) => console.error('Falha ao reconectar:', safeErrorCode(e)));
          },
          decision.delayMs
        );
      }
    }
  });

  s.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    if (!isLive()) {
      for (const message of messages) bufferUntilIdentityOpen(message);
      return;
    }
    // syncing = TRUE enquanto o lote está sendo processado, FALSE ao terminar
    // (preserva o estado real; isLatest é só informação de log).
    tracker.markSyncing(gen, true);
    console.log(`📥 History sync: ${chats.length} chats, ${messages.length} mensagens (isLatest=${isLatest})`);
    try {
      for (const c of chats) {
        if (!(await allowedAttempt(isLive))) return;
        if (isIgnorableJid(c.id)) continue;
        if (confidentialMetadata) {
          try { await confidentialMetadata.putChat(c.id, c.name || null, c.id.endsWith('@g.us')); }
          catch (error) { console.error('Erro ao salvar conversa cifrada:', safeErrorCode(error)); }
          continue;
        }
        // History metadata is not proof that the corresponding message was saved.
        try { await upsertChat(c.id, c.name || null, c.id.endsWith('@g.us')); }
        catch (error) { console.error('Erro ao salvar metadados de conversa:', safeErrorCode(error)); }
      }
      await handleContacts(contacts, isLive);
      // A confidential commit needs multiple remote, durable Supabase writes.
      // Serializing a large history batch can take hours and leave fresh
      // messages waiting. Keep a small bounded set of commits in flight; each
      // message is staged before its own commit and fenced at every await.
      let nextMessage = 0;
      const workerCount = confidentialMessages ? Math.min(6, messages.length) : 1;
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextMessage < messages.length) {
          const m = messages[nextMessage++];
          if (!(await allowedAttempt(isLive))) return; // stale socket: no new writes
          try { if (!(await storeMessage(m, isLive))) retryFailedMessage(m, isLive); }
          catch (error) {
            console.error('Erro ao salvar mensagem do histórico:', safeErrorCode(error));
            retryFailedMessage(m, isLive);
          }
        }
      }));
    } catch (e) {
      console.error('Erro no history sync:', safeErrorCode(e));
    } finally {
      if (isLive()) tracker.markSyncing(gen, false);
    }
  });

  s.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!isLive()) { bufferUntilIdentityOpen(m, true); continue; }
      try {
        if (!(await storeMessage(m, isLive))) retryFailedMessage(m, isLive, true);
      } catch (e) {
        console.error('Erro ao salvar mensagem:', safeErrorCode(e));
        retryFailedMessage(m, isLive, true);
      }
    }
  });

  s.ev.on('chats.upsert', async (chats) => {
    if (!isLive()) return;
    for (const c of chats) {
      if (!(await allowedAttempt(isLive))) return;
      if (isIgnorableJid(c.id)) continue;
      if (confidentialMetadata) {
        await confidentialMetadata.putChat(c.id, c.name || null, c.id.endsWith('@g.us')).catch((error) =>
          console.error('Erro ao salvar conversa cifrada:', safeErrorCode(error)));
        continue;
      }
      await upsertChat(c.id, c.name || null, c.id.endsWith('@g.us')).catch(() => {});
    }
  });

  s.ev.on('chats.update', async (updates) => {
    if (!isLive()) return;
    for (const c of updates) {
      if (!(await allowedAttempt(isLive))) return;
      if (!c.id || isIgnorableJid(c.id)) continue;
      if (confidentialMetadata) {
        if (c.name) await confidentialMetadata.putChat(c.id, c.name, c.id.endsWith('@g.us')).catch((error) =>
          console.error('Erro ao atualizar conversa cifrada:', safeErrorCode(error)));
        continue;
      }
      if (c.name) await upsertChat(c.id, c.name, c.id.endsWith('@g.us')).catch(() => {});
    }
  });

  s.ev.on('contacts.upsert', async (contacts) => {
    if (!isLive()) return;
    await handleContacts(contacts, isLive).catch(() => {});
  });

  s.ev.on('contacts.update', async (contacts) => {
    if (!isLive()) return;
    await handleContacts(contacts, isLive).catch(() => {});
  });

  s.ev.on('groups.upsert', async (groups) => {
    if (!isLive()) return;
    for (const g of groups) {
      if (!(await allowedAttempt(isLive))) return;
      if (confidentialMetadata) {
        if (g.id && g.subject) await confidentialMetadata.putChat(g.id, g.subject, true).catch((error) =>
          console.error('Erro ao salvar grupo cifrado:', safeErrorCode(error)));
        continue;
      }
      if (g.id && g.subject) await upsertChat(g.id, g.subject, true).catch(() => {});
    }
  });

  s.ev.on('groups.update', async (groups) => {
    if (!isLive()) return;
    for (const g of groups) {
      if (!(await allowedAttempt(isLive))) return;
      if (confidentialMetadata) {
        if (g.id && g.subject) await confidentialMetadata.putChat(g.id, g.subject, true).catch((error) =>
          console.error('Erro ao atualizar grupo cifrado:', safeErrorCode(error)));
        continue;
      }
      if (g.id && g.subject) await upsertChat(g.id, g.subject, true).catch(() => {});
    }
  });
}

/**
 * Falha de startup (ex.: version fetch fora do ar): registra a queda com
 * estado explícito e agenda UM retry cercado (FencedTimer + backoff). Uma
 * geração nova (start/logout manual) cancela o agendamento — sem storm.
 */
function failAttempt(gen: number, e: unknown, what: string) {
  console.error(`Falha ao ${what} (nova tentativa agendada):`, safeErrorCode(e));
  const decision = tracker.markDisconnected(gen, undefined); // 'unknown' → autoRetry com backoff
  retryTimer.schedule(
    gen,
    () => {
      startWhatsApp().catch((err) => console.error('Falha ao reconectar:', safeErrorCode(err)));
    },
    decision.delayMs
  );
}

/** Busca os subjects de todos os grupos que participo e grava como nome do chat. */
export async function syncGroupNames() {
  const s=sock,gen=tracker.currentGeneration;
  const isLive=()=>!stopped&&sock===s&&tracker.isCurrent(gen);
  if(!s||!(await allowedAttempt(isLive)))return;
  const groups = await s.groupFetchAllParticipating();
  if(!(await allowedAttempt(isLive)))return;
  let n = 0;
  for (const [jid, meta] of Object.entries(groups)) {
    if (meta.subject) {
      if(!(await allowedAttempt(isLive)))return;
      if (confidentialMetadata) await confidentialMetadata.putChat(jid, meta.subject, true);
      else await upsertChat(jid, meta.subject, true);
      n++;
    }
  }
  console.log(`👥 Nomes de ${n} grupos sincronizados.`);
}

/**
 * Sincroniza os nomes da agenda via app state sync (coleção critical_unblock_low,
 * que carrega os contactAction com fullName + lidJid).
 * Se wa_contacts está (quase) vazia, zera a versão local da coleção para forçar
 * um snapshot completo do servidor — isso NÃO afeta o pareamento nem as credenciais.
 */
export async function syncContacts() {
  const s=sock,keys=authKeys,gen=tracker.currentGeneration;
  const isLive=()=>!stopped&&sock===s&&tracker.isCurrent(gen);
  if(!s||!(await allowedAttempt(isLive)))return;
  if (confidentialMetadata) {
    await s.resyncAppState(['critical_unblock_low'], false);
    if (await allowedAttempt(isLive)) await resolveUnmappedLids();
    return;
  }
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM wa_contacts')).rows[0].n as number;
  if(!(await allowedAttempt(isLive)))return;
  if (before < 5 && keys) {
    console.log('🔄 wa_contacts vazia — forçando resync completo da agenda (critical_unblock_low)...');
    await keys.set({ 'app-state-sync-version': { critical_unblock_low: null } });
  }
  if(!(await allowedAttempt(isLive)))return;
  await s.resyncAppState(['critical_unblock_low'], false);
  // eventos do resync chegam bufferizados — espera um pouco antes de contar
  await new Promise((r) => setTimeout(r, 5000));
  if(!(await allowedAttempt(isLive)))return;
  const after = (await pool.query('SELECT COUNT(*)::int AS n FROM wa_contacts')).rows[0].n as number;
  if(!(await allowedAttempt(isLive)))return;
  const mapped = (await pool.query('SELECT COUNT(*)::int AS n FROM wa_lid_map')).rows[0].n as number;
  console.log(`📇 Contatos sincronizados: ${before} -> ${after} (mapeamentos LID: ${mapped}).`);
  await resolveUnmappedLids().catch((e) => console.error('Erro no usync de LIDs:', safeErrorCode(e)));
}

/**
 * Melhor esforço: tenta resolver via USync os chats @lid que ainda não têm
 * mapeamento para número. O WhatsApp pode não responder para contatos com
 * privacidade de número ativada — nesse caso o fallback é o próprio LID, e o
 * mapeamento se resolve sozinho na próxima mensagem recebida (attr sender_pn).
 */
async function resolveUnmappedLids() {
  const s=sock,gen=tracker.currentGeneration;
  const isLive=()=>!stopped&&sock===s&&tracker.isCurrent(gen);
  if(!s||!(await allowedAttempt(isLive)))return;
  if (confidentialMetadata) {
    const chats = await confidentialMetadata.chatList();
    const mapped = new Set((await confidentialMetadata.lidMapList()).map((item) => item.lid));
    const lids = chats.map((item) => item.jid).filter((jid) => jid.endsWith('@lid') && !mapped.has(jid));
    if (!lids.length) return;
    const query = new USyncQuery().withLIDProtocol().withContactProtocol();
    for (const lid of lids) query.withUser(new USyncUser().withId(lid).withLid(lid));
    if (!(await allowedAttempt(isLive))) return;
    const results = await s.executeUSyncQuery(query);
    if (!(await allowedAttempt(isLive))) return;
    for (const item of (results?.list || []) as Array<{ id?: string; lid?: string }>) {
      const pn = item.id?.endsWith('@s.whatsapp.net') ? item.id : null;
      const lid = item.lid || (item.id?.endsWith('@lid') ? item.id : null);
      if (pn && lid) {
        if (!(await allowedAttempt(isLive))) return;
        await confidentialMetadata.putLidMap(lid, pn);
      }
    }
    return;
  }
  const r = await pool.query(
    `SELECT ch.jid FROM wa_chats ch
     LEFT JOIN wa_lid_map lm ON lm.lid = ch.jid
     WHERE ch.jid LIKE '%@lid' AND lm.lid IS NULL`
  );
  if(!(await allowedAttempt(isLive)))return;
  const lids: string[] = r.rows.map((x) => x.jid);
  if (!lids.length) return;
  const usyncQuery = new USyncQuery().withLIDProtocol().withContactProtocol();
  for (const lid of lids) usyncQuery.withUser(new USyncUser().withId(lid).withLid(lid));
  if(!(await allowedAttempt(isLive)))return;
  const results = await s.executeUSyncQuery(usyncQuery);
  if(!(await allowedAttempt(isLive)))return;
  let n = 0;
  for (const item of (results?.list || []) as Array<{ id?: string; lid?: string }>) {
    const pn = item.id?.endsWith('@s.whatsapp.net') ? item.id : null;
    const lid = item.lid || (item.id?.endsWith('@lid') ? item.id : null);
    if (pn && lid) {
      if(!(await allowedAttempt(isLive)))return;
      await upsertLidMap(lid, pn);
      n++;
    }
  }
  console.log(`🔎 USync de LIDs: ${lids.length} pendentes, ${n} resolvidos.`);
}

export function flushWhatsAppState():Promise<void>{return credsWrite;}

function stopWhatsApp(preservePending: boolean): void {
  stopped = true;
  tracker.markStopped();
  retryTimer.clear();
  progressTimer.clear();
  if (pendingRetryHandle) clearTimeout(pendingRetryHandle);
  pendingRetryHandle = null;
  pendingRetryDelay = null;
  if (!preservePending) { pendingMessages.clear(); livePendingKeys.clear(); }
  const old = sock;
  sock = null;
  authKeys = null;
  me = null;
  try { old?.end(undefined); } catch {}
}

export function pauseWhatsApp(): void { stopWhatsApp(false); }

export async function logoutWhatsApp(): Promise<void> {
  if (stopping) return stopping;
  pendingMessages.clear();
  livePendingKeys.clear();
  if (pendingRetryHandle) clearTimeout(pendingRetryHandle);
  pendingRetryHandle = null;
  pendingRetryDelay = null;
  stopped = true;
  tracker.markStopped();
  const stopGeneration = tracker.currentGeneration;
  retryTimer.clear();
  progressTimer.clear();
  const old = sock;
  sock = null;
  authKeys = null;
  me = null;
  stopping = (async () => {
    try { await Promise.race([old?.logout(), new Promise(resolve => setTimeout(resolve, 5000))]); } catch {}
    try { old?.end(undefined); } catch {}
    await credsWrite;
    if (confidentialAuth) await confidentialAuth.clearCurrent();
    else { try { rmSync(config.authDir, { recursive: true, force: true }); } catch {} }
  })().finally(() => { stopping = null; });
  await stopping;
  // A pause or newer intent wins over a pending explicit logout. Starting a
  // fresh QR is a subsequent user action; logout never reconnects by itself.
  if (tracker.currentGeneration !== stopGeneration) return;
}

/**
 * Reconexão pedida explicitamente pelo usuário (ex.: QR expirou, ou após
 * resolver uma ação necessária). Encerra o socket atual e começa uma tentativa
 * nova — NÃO apaga credenciais. Seguro chamar em qualquer estado.
 */
export async function reconnectWhatsApp(): Promise<WaStatus> {
  await startWhatsApp();
  return getStatus();
}

type PairingBackupCode = 'PAIRING_BACKUP_UNSAFE' | 'PAIRING_BACKUP_FAILED';

function pairingBackupError(code: PairingBackupCode): Error & { code: PairingBackupCode } {
  return Object.assign(new Error(code), { code });
}

/**
 * Explicitly start a new WhatsApp pairing. Existing auth is moved to a private
 * sibling directory on the same filesystem; it is never deleted by this path.
 * Rotation is single-flight and waits for all in-progress credential writes.
 */
export function beginFreshPairing(): Promise<WaStatus> {
  if (confidentialAuth && (!confidentialMessagesReady || !confidentialMetadataReady))
    return Promise.reject(new Error('CONFIDENTIAL_STORES_NOT_READY'));
  if (pairingFlight) return pairingFlight;
  pairingRotating = true;
  pairingFlight = (async () => {
    if (confidentialAuth && !(await authorizeActiveIngestion()))
      throw new Error('CONFIDENTIAL_MESSAGES_NOT_AUTHORIZED');
    stopWhatsApp(true);
    if (starting) await starting;
    if (stopping) await stopping;
    await credsWrite;

    if (confidentialAuth) {
      try {
        if (!confidentialAuth.hasIdentity()) {
          const previousJid = (await confidentialAuth.load()).state.creds?.me?.id;
          await confidentialAuth.assertOrEstablishIdentity(previousJid);
        }
        await confidentialAuth.beginFreshPairing();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'PAIRING_ACCOUNT_MISMATCH' || code === 'PAIRING_IDENTITY_UNAVAILABLE') {
          pairingError = code;
          throw identityError(code);
        }
        throw pairingBackupError('PAIRING_BACKUP_FAILED');
      }
      pairingError = null;
      pairingRotating = false;
      await startWhatsApp();
      return getStatus();
    }

    // Normalize trailing separators before lstat: lstat("symlink/") follows a
    // symlink on POSIX, which would bypass the directory safety check.
    const authDir = resolve(config.authDir);
    if (dirname(authDir) === authDir) throw pairingBackupError('PAIRING_BACKUP_UNSAFE');
    let hasPreviousAuth = false;
    try {
      const stat = lstatSync(authDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw pairingBackupError('PAIRING_BACKUP_UNSAFE');
      hasPreviousAuth = true;
    } catch (error) {
      if ((error as { code?: string }).code === 'PAIRING_BACKUP_UNSAFE') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw pairingBackupError('PAIRING_BACKUP_FAILED');
    }

    try {
      const lock = readIdentityLock(authDir);
      if (!lock) {
        if (!hasPreviousAuth) throw identityError('PAIRING_IDENTITY_UNAVAILABLE');
        const previous = await useMultiFileAuthState(authDir);
        establishIdentityLock(authDir, previous.state.creds?.me?.id);
      }
    } catch (error) {
      const code = (error as { code?: PairingErrorCode }).code;
      pairingError = code === 'PAIRING_ACCOUNT_MISMATCH' ? code : 'PAIRING_IDENTITY_UNAVAILABLE';
      throw identityError(pairingError);
    }

    let backupDir: string | null = null;
    if (hasPreviousAuth) {
      backupDir = join(dirname(authDir), `.${basename(authDir)}.backup-${Date.now()}-${randomUUID()}`);
      try {
        // A directory backup inherits the original permissions. Ensure the
        // archived Signal keys remain inaccessible to other local users.
        chmodSync(authDir, 0o700);
        renameSync(authDir, backupDir);
      } catch {
        throw pairingBackupError('PAIRING_BACKUP_FAILED');
      }
    }

    try {
      mkdirSync(authDir, { recursive: true, mode: 0o700 });
      chmodSync(authDir, 0o700);
    } catch {
      if (backupDir) {
        try {
          rmSync(authDir, { recursive: true, force: true });
          renameSync(backupDir, authDir);
        } catch {
          // The archived state remains in its private sibling directory.
        }
      }
      throw pairingBackupError('PAIRING_BACKUP_FAILED');
    }

    pairingError = null;
    pairingRotating = false;
    await startWhatsApp();
    return getStatus();
  })().finally(() => {
    pairingRotating = false;
    pairingFlight = null;
  });
  return pairingFlight;
}

/** Nome de exibição de um chat: nome do chat > agenda > pushName > número formatado. */
export async function resolveChatName(jid: string, stored: string | null): Promise<string> {
  if (stored) return stored;
  const r = await pool.query(
    `SELECT COALESCE(ct.name, ct2.name, ct.notify, ct2.notify) AS name, lm.pn
     FROM (SELECT $1::text AS jid) j
     LEFT JOIN wa_lid_map lm ON lm.lid = j.jid
     LEFT JOIN wa_contacts ct ON ct.jid = j.jid
     LEFT JOIN wa_contacts ct2 ON ct2.jid = lm.pn`,
    [jid]
  );
  const row = r.rows[0];
  if (row?.name) return row.name;
  return formatPhoneFromJid(row?.pn) || formatPhoneFromJid(jid) || jid.split('@')[0];
}
