import { Hono } from 'hono';
import type { Pool } from 'pg';

export const READ_CONSENT_VERSION = 'readonly-2026-10-15';
export const CONSENT_SCHEMA = `CREATE TABLE IF NOT EXISTS suco_consents (
  version TEXT PRIMARY KEY,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  scope TEXT NOT NULL CHECK (scope = 'personal_readonly_sync_and_analysis')
);`;

export function onboardingRoutes(db: Pick<Pool, 'query'>) {
  const routes = new Hono();
  async function state() {
    const consent = await db.query('SELECT version, accepted_at AS "acceptedAt" FROM suco_consents WHERE version = $1', [READ_CONSENT_VERSION]);
    const summary = await db.query('SELECT * FROM summaries ORDER BY created_at ASC LIMIT 1');
    // This includes owner/paid requests, whose reservation_id may be NULL.
    // Never infer safety from the free-credit counter alone.
    const requests = await db.query("SELECT EXISTS (SELECT 1 FROM suco_summary_requests WHERE phase NOT IN ('failed','committed')) AS pending");
    return { consent: consent.rows[0] ?? null, firstSummary: summary.rows[0] ?? null, recovery: {canRestart: requests.rows[0]?.pending === false} };
  }
  routes.get('/', async c => c.json(await state()));
  routes.post('/consent', async c => {
    const input: unknown = await c.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input) || (input as any).accepted !== true || (input as any).version !== READ_CONSENT_VERSION || Object.keys(input).some(k => !['accepted','version'].includes(k))) return c.json({error:'Leia as informações e autorize explicitamente a leitura antes de conectar.'},400);
    await db.query("INSERT INTO suco_consents (version, scope) VALUES ($1, 'personal_readonly_sync_and_analysis') ON CONFLICT (version) DO NOTHING", [READ_CONSENT_VERSION]);
    return c.json(await state());
  });
  return routes;
}
