const encoder = new TextEncoder();
const keySize = 32;
const recoveryPrefix = 'SUCO1-';
const databaseName = 'suco-confidential-keys-v1';
const storeName = 'keys';
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalKeyRecord {
  id: string;
  version: 1;
  wrapKey: CryptoKey;
  nonce: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface LocalKeyStorage {
  read(id: string): Promise<LocalKeyRecord | null>;
  insert(record: LocalKeyRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

function keyId(ownerId: string, epoch: number): string {
  if (!ownerPattern.test(ownerId) || !Number.isSafeInteger(epoch) || epoch < 1 || epoch > 1_000_000_000)
    throw Error('LOCAL_KEY_CONTEXT');
  return `${ownerId.toLowerCase()}:${epoch}`;
}

function toBase64Url(value: Uint8Array): string {
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw Error('RECOVERY_CODE_INVALID');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const decoded = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
  if (decoded.length !== keySize || toBase64Url(decoded) !== value) throw Error('RECOVERY_CODE_INVALID');
  return decoded;
}

export function formatRecoveryCode(raw: Uint8Array): string {
  if (raw.length !== keySize) throw Error('RECOVERY_CODE_INVALID');
  return recoveryPrefix + toBase64Url(raw);
}

export function parseRecoveryCode(code: string): Uint8Array {
  const trimmed = code.trim();
  if (!trimmed.startsWith(recoveryPrefix)) throw Error('RECOVERY_CODE_INVALID');
  return fromBase64Url(trimmed.slice(recoveryPrefix.length));
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
    request.onblocked = () => reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
  });
}

async function transaction<T>(mode: IDBTransactionMode, makeRequest: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(storeName, mode);
      const request = makeRequest(tx.objectStore(storeName));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
      tx.onabort = () => reject(Error('LOCAL_KEY_STORAGE_UNAVAILABLE'));
    });
  } finally { database.close(); }
}

export const browserLocalKeyStorage: LocalKeyStorage = {
  async read(id) { return (await transaction('readonly', store => store.get(id))) as LocalKeyRecord | null || null; },
  async insert(record) { await transaction('readwrite', store => store.add(record)); },
  async remove(id) { await transaction('readwrite', store => store.delete(id)); },
};

/** The raw key is stored only as ciphertext; the local wrapping key cannot be exported. */
export async function saveLocalKey(ownerId: string, epoch: number, raw: Uint8Array,
  storage: LocalKeyStorage = browserLocalKeyStorage): Promise<void> {
  const id = keyId(ownerId, epoch);
  if (raw.length !== keySize) throw Error('LOCAL_KEY_SIZE');
  if (await storage.read(id)) throw Error('LOCAL_KEY_EXISTS');
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource,
    additionalData: encoder.encode(`suco-local-key-v1:${id}`) as BufferSource },
    wrapKey, raw as BufferSource);
  await storage.insert({ id, version: 1, wrapKey, nonce, ciphertext });
}

export async function loadLocalKey(ownerId: string, epoch: number,
  storage: LocalKeyStorage = browserLocalKeyStorage): Promise<Uint8Array | null> {
  const id = keyId(ownerId, epoch);
  const record = await storage.read(id);
  if (!record) return null;
  if (record.id !== id || record.version !== 1 || record.nonce?.length !== 12 ||
      !(record.ciphertext instanceof ArrayBuffer)) throw Error('LOCAL_KEY_DAMAGED');
  try {
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.nonce as BufferSource,
      additionalData: encoder.encode(`suco-local-key-v1:${id}`) as BufferSource }, record.wrapKey, record.ciphertext));
    if (clear.length !== keySize) { clear.fill(0); throw Error('LOCAL_KEY_DAMAGED'); }
    return clear;
  } catch { throw Error('LOCAL_KEY_DAMAGED'); }
}

export async function forgetLocalKey(ownerId: string, epoch: number,
  storage: LocalKeyStorage = browserLocalKeyStorage): Promise<void> {
  await storage.remove(keyId(ownerId, epoch));
}
