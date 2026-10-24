import { existsSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createOperationalGateway } from './operational-gateway.mjs';
import { deploymentPin } from './deployment-pin.mjs';
import { createPrivateDaily } from './private-daily.mjs';

// The deployer pins their own Supabase project at build time (Dockerfile.worker bakes it in; shape-checked, never defaulted).
const supabaseUrl = process.env.SUCO_SUPABASE_URL;
const publishableKey = process.env.SUCO_SUPABASE_PUBLISHABLE_KEY;
const tunnelToken = process.env.TUNNEL_TOKEN;
if (process.env.SUCO_CONFIDENTIAL_RUNTIME !== '1' || process.env.DATABASE_URL ||
    process.env.API_TOKEN || !publishableKey?.startsWith('sb_publishable_') ||
    !/^https:\/\/[a-z0-9][a-z0-9-]{19,30}\.supabase\.co$/.test(supabaseUrl || '') ||
    typeof tunnelToken !== 'string' || !/^[A-Za-z0-9._=-]{100,4096}$/.test(tunnelToken) ||
    !existsSync('/usr/local/bin/cloudflared') ||
    !existsSync('/run/container_launcher/teeserver.sock') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deploymentPin.ownerId) ||
    (deploymentPin.fingerprint !== null && !/^[0-9a-f]{64}$/.test(deploymentPin.fingerprint))) {
  throw Error('ATTESTED_WORKER_BOOT_REQUIRED');
}

const [{ prepareConfidentialRuntime }, { createSupabaseOwnerSession }, wa,
  { app, installConfidentialApiAuthorizer, installConfidentialSummaryService },
  { createConfidentialSummaryService }, { JUICE_CATALOG_VERSION },
  { createConfidentialKeyProvider }, { createConfidentialTranscriber }] = await Promise.all([
  import('/app/backend/dist/lib/confidential-runtime.js'),
  import('/app/backend/dist/lib/supabase-owner-session.js'),
  import('/app/backend/dist/wa.js'),
  import('/app/backend/dist/api.js'),
  import('/app/backend/dist/lib/confidential-summary-service.js'),
  import('/app/backend/dist/juice-catalog.js'),
  import('/app/backend/dist/lib/confidential-glm.js'),
  import('/app/backend/dist/lib/confidential-audio.js'),
]);

let runtime = null;
let activeWorker = null;
let releasedKeyDigest = null;
const gateway = createOperationalGateway({
  onRelease: async release => {
    if (release?.ownerId !== deploymentPin.ownerId ||
        typeof release.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(release.key))
      throw Error('WORKER_TENANT_MISMATCH');
    const rawKey = Buffer.from(release.key, 'base64url');
    if (rawKey.length !== 32 || rawKey.toString('base64url') !== release.key) {
      rawKey.fill(0); throw Error('WORKER_KEY_INPUT');
    }
    const keyDigest = createHash('sha256').update(rawKey).digest();
    rawKey.fill(0);
    if (runtime) {
      try {
        if (!releasedKeyDigest || !timingSafeEqual(keyDigest, releasedKeyDigest) || !activeWorker)
          throw Error('WORKER_REATTACH_DENIED');
        const candidate = createSupabaseOwnerSession({
          url: supabaseUrl, publishableKey, ownerId: release.ownerId,
          accessToken: release.accessToken, refreshToken: release.refreshToken,
        });
        try {
          const account = await candidate.verifiedAccount();
          if (account.privateState !== 'active' ||
              (deploymentPin.fingerprint ? account.entitlement !== 'owner'
                : account.entitlement !== 'partner_full'))
            throw Error('WORKER_REATTACH_DENIED');
          const current = candidate.currentCredentials();
          await runtime.owner.recoverCredentials(current.accessToken, current.refreshToken);
        } finally { candidate.close(); }
        return activeWorker;
      } finally { keyDigest.fill(0); }
    }
    let prepared;
    try {
      prepared = await prepareConfidentialRuntime({
        release, supabaseUrl, publishableKey,
        pinnedOwnerIdentity: deploymentPin.fingerprint
          ? { ownerId: deploymentPin.ownerId, fingerprint: deploymentPin.fingerprint }
          : undefined,
      });
    } catch (error) { keyDigest.fill(0); throw error; }
    let installationAttempted = false;
    try {
      installationAttempted = true;
      wa.installConfidentialAuth(prepared.auth, prepared.authorize, prepared.pairingPolicy);
      await wa.installConfidentialMessageStore(prepared.messages);
      await wa.installConfidentialMetadataStore(prepared.metadata);
      // Voice notes: opus → 30 s WAV slices → GLM-ASR, all inside the TEE.
      wa.installConfidentialTranscriber(createConfidentialTranscriber({
        keyProvider: createConfidentialKeyProvider(),
      }));
      const bearer = randomBytes(32).toString('base64url');
      const bearerDigest = createHash('sha256').update(bearer).digest();
      installConfidentialApiAuthorizer({
        ownerId: release.ownerId,
        verifyBearerToken: async token => {
          if (typeof token !== 'string' || token.length !== bearer.length) return null;
          const digest = createHash('sha256').update(token).digest();
          return timingSafeEqual(digest, bearerDigest) ? release.ownerId : null;
        },
      });
      const summaryService = createConfidentialSummaryService({
        messages: prepared.messages, metadata: prepared.metadata,
        summaries: prepared.summaries, glm: prepared.glm,
      });
      installConfidentialSummaryService(summaryService);
      const daily = createPrivateDaily({ ownerId: release.ownerId, secret: keyDigest,
        messages: prepared.messages, metadata: prepared.metadata,
        summaries: summaryService, authorize: prepared.authorize,
        catalogVersion: JUICE_CATALOG_VERSION,
        syncing: () => wa.getStatus().syncing });
      const worker = {
        async dispatch(call) {
          if (!runtime || !await runtime.authorize()) {
            return { status: 403, body: { code: 'ACCOUNT_NOT_ACTIVE' } };
          }
          const payload = call.body === undefined ? undefined : JSON.stringify(call.body);
          if (payload && Buffer.byteLength(payload) > 256 * 1024) {
            return { status: 413, body: { code: 'BODY_TOO_LARGE' } };
          }
          const request = new Request(`https://worker.internal${call.path}`, {
            method: call.method,
            headers: { Authorization: `Bearer ${bearer}`,
              ...(payload ? { 'Content-Type': 'application/json' } : {}) },
            ...(call.method === 'POST' && payload ? { body: payload } : {}),
          });
          const response = await app.fetch(request);
          const bodyText = await response.text();
          if (bodyText.length > 256_000) return { status: 413, body: { code: 'RESPONSE_TOO_LARGE' } };
          let body;
          try { body = bodyText ? JSON.parse(bodyText) : null; }
          catch { return { status: 502, body: { code: 'INVALID_WORKER_RESPONSE' } }; }
          return { status: response.status, body };
        },
        close() {
          daily.close();
          wa.pauseWhatsApp(); prepared.close(); runtime = null; activeWorker = null;
          bearerDigest.fill(0); releasedKeyDigest?.fill(0); releasedKeyDigest = null;
        },
      };
      runtime = prepared;
      activeWorker = worker;
      releasedKeyDigest = keyDigest;
      void wa.startWhatsApp().catch(() => {
        // Status endpoint exposes a sanitized recovery state; never log QR or credentials.
      });
      daily.start();
      return worker;
    } catch (error) {
      keyDigest.fill(0);
      prepared.close();
      // Partial singleton installation cannot safely be retried in this process.
      if (installationAttempted) setImmediate(() => process.exit(1));
      throw error;
    }
  },
});

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('INVALID_PORT');
gateway.server.listen(port, '0.0.0.0');
const tunnel = spawn('/usr/local/bin/cloudflared',
  ['tunnel', '--protocol', 'http2', '--no-autoupdate', 'run'],
  { env: { TUNNEL_TOKEN: tunnelToken }, stdio: 'ignore' });
delete process.env.TUNNEL_TOKEN;
let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  tunnel.kill('SIGTERM');
  gateway.close();
};
tunnel.once('error', () => { stop(); process.exit(1); });
tunnel.once('exit', () => { if (!shuttingDown) { stop(); process.exit(1); } });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { stop(); process.exit(0); });
}
