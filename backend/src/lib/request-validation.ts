/** Reject malformed request shapes before SQL/model work. No input is logged. */
export function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validQueryInputs(query: Record<string, string | undefined>): boolean {
  for (const key of ['limit', 'offset']) {
    const value = query[key];
    if (value !== undefined && (!/^\d{1,10}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (key === 'limit' ? 1 : 0) || Number(value) > (key === 'limit' ? 5000 : 1_000_000))) return false;
  }
  if (['q','tag','kind','chat_jid'].some(key => typeof query[key] === 'string' && query[key]!.length > 500)) return false;
  const start = query.start, end = query.end;
  if ([start,end].some(value => value !== undefined && (!value || value.length > 64 || !Number.isFinite(Date.parse(value))))) return false;
  return !(start && end && Date.parse(start) > Date.parse(end));
}
export function validSummaryInput(body: Record<string, unknown>): boolean {
  if (typeof body.chat_jid !== 'string' || !body.chat_jid || body.chat_jid.length > 256) return false;
  if ([body.start,body.end].some(value => typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value)))) return false;
  if (Date.parse(body.start as string) > Date.parse(body.end as string)) return false;
  for (const [key,max] of [['analysis_type',100],['base_prompt',24000],['title',300],['request_id',128],['template_version',80],['personal_revision',80],['focus',2000]] as const) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || (body[key] as string).length > max)) return false;
  }
  return true;
}
/** Error objects/messages may contain SQL parameters, source text or provider payloads. */
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as {code:unknown}).code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'INTERNAL_ERROR';
}
