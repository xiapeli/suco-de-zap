import { scryptSync, timingSafeEqual } from 'node:crypto';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { createConfidentialAuthState, ConfidentialAuthError, legacyIdentityLockFingerprint,
  type ConfidentialAuthAdapter, type LegacyIdentityProof } from './confidential-auth-state.js';
import { createSupabaseAuthStore } from './supabase-auth-store.js';
import { createConfidentialMessageStore, type ConfidentialMessageStore } from './confidential-message-store.js';
import { createConfidentialMetadataStore, type ConfidentialMetadataStore } from './confidential-metadata-store.js';
import { createConfidentialSummaryStore, type ConfidentialSummaryStore } from './confidential-summary-store.js';
import { createConfidentialGlm, type ConfidentialGlm } from './confidential-glm.js';
import { createSupabaseOwnerSession, type OwnerSession } from './supabase-owner-session.js';

export interface ConfidentialRelease {
  version: 1;
  ownerId: string;
  keyEpoch: number;
  key: string;
  accessToken: string;
  refreshToken: string;
  /** Owner-only data delivered through the attested private channel, never logs or a public API. */
  legacyIdentity?: { jid: string; proof: LegacyIdentityProof };
}

export interface ConfidentialRuntime {
  auth: ConfidentialAuthAdapter;
  messages: ConfidentialMessageStore;
  metadata: ConfidentialMetadataStore;
  summaries: ConfidentialSummaryStore;
  glm: ConfidentialGlm;
  owner: OwnerSession;
  authorize: () => Promise<boolean>;
  pairingPolicy: 'existing-bound' | 'new-account';
  close(): void;
}

function verifyPinnedLegacyIdentity(
  legacyIdentity: { jid: string; proof: LegacyIdentityProof }, pinnedFingerprint: string,
): void {
  if (!legacyIdentity || typeof legacyIdentity.jid !== 'string')
    throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
  const jid = jidNormalizedUser(legacyIdentity.jid.trim());
  if (!/^\d{5,20}@s\.whatsapp\.net$/.test(jid))
    throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
  const actual = legacyIdentityLockFingerprint(legacyIdentity.proof);
  if (!timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(pinnedFingerprint, 'hex')))
    throw new ConfidentialAuthError('PAIRING_IDENTITY_UNAVAILABLE');
  const digest = scryptSync(jid, Buffer.from(legacyIdentity.proof.salt, 'hex'), 32);
  if (!timingSafeEqual(digest, Buffer.from(legacyIdentity.proof.digest, 'hex')))
    throw new ConfidentialAuthError('PAIRING_ACCOUNT_MISMATCH');
}

/**
 * Called only after the client has verified image measurement and bound the
 * HPKE key to a fresh attestation token. The release never enters a process
 * outside the measured Confidential Space container.
 */
export async function prepareConfidentialRuntime(args: {
  release: ConfidentialRelease;
  supabaseUrl: string;
  publishableKey: string;
  /** Baked into the measured owner image, independently of the client release. */
  pinnedOwnerIdentity?: { ownerId: string; fingerprint: string };
  fetcher?: typeof fetch;
}): Promise<ConfidentialRuntime> {
  const { release } = args;
  if (release?.version !== 1 || !Number.isInteger(release.keyEpoch) || release.keyEpoch < 1 ||
    release.keyEpoch > 1_000_000_000 || typeof release.key !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(release.key)) throw Error('CONFIDENTIAL_RELEASE_INPUT');
  const key = Buffer.from(release.key, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== release.key) {
    key.fill(0);
    throw Error('CONFIDENTIAL_RELEASE_INPUT');
  }
  let owner: OwnerSession | null = null;
  let auth: ConfidentialAuthAdapter | null = null;
  let messages: ConfidentialMessageStore | null = null;
  let metadata: ConfidentialMetadataStore | null = null;
  let summaries: ConfidentialSummaryStore | null = null;
  try {
    owner = createSupabaseOwnerSession({
      url: args.supabaseUrl, publishableKey: args.publishableKey,
      ownerId: release.ownerId, accessToken: release.accessToken,
      refreshToken: release.refreshToken, fetcher: args.fetcher,
    });
    const account = await owner.verifiedAccount();
    if (account.privateState !== 'active') throw Error('CONFIDENTIAL_ACCOUNT_PENDING');
    const pairingPolicy = account.entitlement === 'owner' ? 'existing-bound' : 'new-account';
    if (pairingPolicy === 'existing-bound') {
      const pin = args.pinnedOwnerIdentity;
      if (!pin || pin.ownerId !== release.ownerId || !/^[a-f0-9]{64}$/.test(pin.fingerprint))
        throw Error('CONFIDENTIAL_OWNER_IDENTITY_PIN_REQUIRED');
      if (release.legacyIdentity !== undefined)
        verifyPinnedLegacyIdentity(release.legacyIdentity, pin.fingerprint);
    } else if (release.legacyIdentity !== undefined) {
      throw Error('CONFIDENTIAL_PARTNER_LEGACY_IDENTITY_FORBIDDEN');
    }
    const userJwt = () => owner!.userJwt();
    const store = createSupabaseAuthStore({
      url: args.supabaseUrl, publishableKey: args.publishableKey,
      ownerId: release.ownerId, userJwt, fetcher: args.fetcher,
    });
    if (pairingPolicy === 'existing-bound' && release.legacyIdentity === undefined && !await store.read())
      throw Error('CONFIDENTIAL_LEGACY_IDENTITY_REQUIRED');
    auth = await createConfidentialAuthState({ tenantId: release.ownerId, key, store });
    if (pairingPolicy === 'existing-bound') {
      if (release.legacyIdentity !== undefined) {
        await auth.importLegacyIdentity(release.legacyIdentity.jid, release.legacyIdentity.proof,
          args.pinnedOwnerIdentity!.fingerprint);
      }
      if (!auth.hasImportedLegacyIdentity()) throw Error('CONFIDENTIAL_LEGACY_IDENTITY_REQUIRED');
    } else if (auth.hasImportedLegacyIdentity()) {
      throw Error('CONFIDENTIAL_PARTNER_LEGACY_IDENTITY_FORBIDDEN');
    }
    messages = createConfidentialMessageStore({
      url: args.supabaseUrl, publishableKey: args.publishableKey,
      ownerId: release.ownerId, tenantId: release.ownerId,
      keyEpoch: release.keyEpoch, key, userJwt, fetcher: args.fetcher,
    });
    metadata = createConfidentialMetadataStore({
      url: args.supabaseUrl, publishableKey: args.publishableKey,
      ownerId: release.ownerId, tenantId: release.ownerId,
      keyEpoch: release.keyEpoch, key, userJwt, fetcher: args.fetcher,
    });
    summaries = createConfidentialSummaryStore({
      url: args.supabaseUrl, publishableKey: args.publishableKey,
      ownerId: release.ownerId, keyEpoch: release.keyEpoch, key,
      userJwt, fetcher: args.fetcher,
    });
    const glm = createConfidentialGlm(release.ownerId, args.fetcher ?? fetch);
    const currentOwner = owner;
    const currentAuth = auth;
    const currentMessages = messages;
    const currentMetadata = metadata;
    const currentSummaries = summaries;
    return {
      owner: currentOwner, auth: currentAuth, messages: currentMessages, metadata: currentMetadata,
      summaries: currentSummaries, glm, pairingPolicy,
      authorize: () => currentOwner.canIngest(),
      close() { currentSummaries.close(); currentMetadata.close(); currentMessages.close(); currentAuth.close(); currentOwner.close(); },
    };
  } catch (error) {
    summaries?.close(); metadata?.close(); messages?.close(); auth?.close(); owner?.close();
    throw error;
  } finally { key.fill(0); }
}
