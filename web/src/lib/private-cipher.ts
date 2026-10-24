// Private-object envelope shared by a verified client and the confidential
// runtime. This module alone does not make a web release operator-blind.
const encoder = new TextEncoder();
const blockSize = 4096;
const maxCiphertext = 4194304;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PrivateObjectContext = {
  accountId: string;
  objectId: string;
  keyEpoch: number;
};
export type PrivateObjectEnvelope = PrivateObjectContext & {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
};

function validate(context: PrivateObjectContext) {
  if (!uuid.test(context.accountId) || !uuid.test(context.objectId) ||
      !Number.isSafeInteger(context.keyEpoch) || context.keyEpoch < 1 ||
      context.keyEpoch > 1000000000) throw new Error('INVALID_PRIVATE_OBJECT_CONTEXT');
}

function aad(context: PrivateObjectContext) {
  validate(context);
  return encoder.encode(`suco-private-object:v1:${context.accountId}:${context.objectId}:${context.keyEpoch}`);
}

export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error('INVALID_CONTENT_KEY');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptPrivateObject(
  key: CryptoKey,
  context: PrivateObjectContext,
  plaintext: Uint8Array,
): Promise<PrivateObjectEnvelope> {
  const associatedData = aad(context);
  if (plaintext.byteLength < 1 || plaintext.byteLength > maxCiphertext - blockSize - 20)
    throw new Error('INVALID_PRIVATE_OBJECT_SIZE');
  const padded = new Uint8Array(Math.ceil((plaintext.byteLength + 4) / blockSize) * blockSize);
  new DataView(padded.buffer).setUint32(0, plaintext.byteLength, false);
  padded.set(plaintext, 4);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  let ciphertext: Uint8Array;
  try {
    ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: associatedData, tagLength: 128 },
      key, padded,
    ));
  } finally {
    padded.fill(0);
  }
  if (ciphertext.byteLength > maxCiphertext) throw new Error('INVALID_PRIVATE_OBJECT_SIZE');
  return { ...context, nonce, ciphertext };
}

export async function decryptPrivateObject(
  key: CryptoKey,
  envelope: PrivateObjectEnvelope,
): Promise<Uint8Array> {
  const associatedData = aad(envelope);
  if (envelope.nonce.byteLength !== 12 || envelope.ciphertext.byteLength < blockSize + 16 ||
      envelope.ciphertext.byteLength > maxCiphertext ||
      (envelope.ciphertext.byteLength - 16) % blockSize !== 0)
    throw new Error('INVALID_PRIVATE_OBJECT_ENVELOPE');
  let padded: Uint8Array;
  try {
    padded = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.nonce, additionalData: associatedData, tagLength: 128 },
      key, envelope.ciphertext,
    ));
  } catch {
    throw new Error('PRIVATE_OBJECT_AUTHENTICATION_FAILED');
  }
  const length = new DataView(padded.buffer).getUint32(0, false);
  if (length < 1 || length > padded.byteLength - 4) {
    padded.fill(0);
    throw new Error('INVALID_PRIVATE_OBJECT_LENGTH');
  }
  const plaintext = padded.slice(4, 4 + length);
  padded.fill(0);
  return plaintext;
}
