import { Hono } from 'hono';
import type { Pool } from 'pg';
import { RateLimiter } from './lib/http-guards.js';

const filler = new Set('o a os as um uma uns umas de do da dos das no na nos nas em e ou que qual quais quem como onde quando quero preciso saber encontrar buscar procura procure encontre sobre ficou foram foi tem tenho meu minha meus minhas seu sua seus suas esse essa aquele aquela por para pelo pela com me eu você voce favor'.split(' '));
const intents = [
  ['combinado', 'combinados', 'decisão', 'decisões', 'decidido', 'acordo'],
  ['prazo', 'prazos', 'entrega', 'entregas', 'vencimento'],
  ['pendência', 'pendências', 'pendente', 'pendentes', 'tarefa', 'tarefas'],
];

export function discoveryInput(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_INPUT');
  const { query, offset = 0 } = body as Record<string, unknown>;
  if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\u0000-\u001f]/.test(query)) throw new Error('INVALID_QUERY');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1000) throw new Error('INVALID_PAGE');
  const terms = [...new Set(query.toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]{2,}/gu)?.filter(term => !filler.has(term)) || [])].slice(0, 12);
  const expanded = new Set(terms);
  for (const group of intents) if (group.some(word => terms.includes(word))) group.forEach(word => expanded.add(word));
  // Only letters/numbers from the user enter websearch's OR vocabulary. SQL remains parameterized.
  return { query: query.trim(), offset: offset as number, terms, alternatives: [...expanded].join(' OR '), allTerms: terms.join(' ') };
}

export function discoverySQL(input: ReturnType<typeof discoveryInput>) {
  const literal = `%${input.query.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_')}%`;
  return {
    text: `WITH q AS (SELECT plainto_tsquery('portuguese',$1) AS all_terms,
      websearch_to_tsquery('portuguese',$2) AS related),
    ranked AS (
      SELECT s.id,s.chat_jid,s.chat_name,s.title,s.analysis_type,s.period_start,s.period_end,s.created_at,
        ts_headline('portuguese',s.content,q.related,
          'StartSel=,StopSel=,MaxWords=45,MinWords=20,MaxFragments=1,FragmentDelimiter= … ') AS excerpt,
        (CASE WHEN concat_ws(' ',s.title,s.chat_name,s.content) ILIKE $3 ESCAPE '!' THEN 8 ELSE 0 END +
         CASE WHEN to_tsvector('portuguese',concat_ws(' ',s.title,s.chat_name,s.content)) @@ q.all_terms THEN 4 ELSE 0 END +
         ts_rank_cd(setweight(to_tsvector('portuguese',COALESCE(s.title,'')),'A') ||
           setweight(to_tsvector('portuguese',COALESCE(s.chat_name,'')),'A') ||
           setweight(to_tsvector('portuguese',s.content),'B'),q.related)) AS score
      FROM summaries s CROSS JOIN q
      WHERE to_tsvector('portuguese',concat_ws(' ',s.title,s.chat_name,s.content)) @@ q.related
        OR concat_ws(' ',s.title,s.chat_name,s.content) ILIKE $3 ESCAPE '!'
    ) SELECT (SELECT COUNT(*)::int FROM summaries) AS saved,
      (SELECT COUNT(*)::int FROM ranked) AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(page)-'score') FROM
        (SELECT * FROM ranked ORDER BY score DESC,created_at DESC,id LIMIT 20 OFFSET $4) page),'[]'::jsonb) AS results`,
    values: [input.allTerms, input.alternatives, literal, input.offset],
    query_timeout: 8000,
  };
}

/** Auth and tenant authorization are inherited from /api/*; never queries vault/messages or a model. */
export function discoveryRoutes(database: Pick<Pool, 'query'>) {
  const routes = new Hono();
  const limiter = new RateLimiter({ windowMs: 60_000, max: 30, maxKeys: 1 });
  routes.post('/', async c => {
    const decision = limiter.check('account');
    if (!decision.allowed) return c.json({ error: 'Muitas buscas seguidas. Aguarde um minuto e tente de novo.' }, 429, { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) });
    let input: ReturnType<typeof discoveryInput>;
    try {
      const raw = await c.req.text();
      if (new TextEncoder().encode(raw).length > 4096) return c.json({ error: 'Escreva um pedido de até 500 caracteres.' }, 413);
      input = discoveryInput(JSON.parse(raw));
    } catch { return c.json({ error: 'Escreva o que deseja buscar, em até 500 caracteres.' }, 400); }
    try {
      const result = await database.query(discoverySQL(input));
      const row = result.rows[0];
      return c.json({ results: row?.results || [], total: row?.total || 0, saved: row?.saved || 0,
        nextOffset: input.offset + 20 < Number(row?.total) && input.offset < 1000 ? input.offset + 20 : null,
        scope: 'saved_summaries', generated: false });
    } catch { return c.json({ error: 'Seus sucos não carregaram. Tente buscar de novo em instantes.' }, 503); }
  });
  return routes;
}
