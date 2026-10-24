import { createHmac } from 'node:crypto';

const zone = 'America/Sao_Paulo';
function clockParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(date);
  const value = name => parts.find(part => part.type === name)?.value ?? '';
  return { day: `${value('year')}-${value('month')}-${value('day')}`, hour: Number(value('hour')) };
}
function previousLocalDay(today, daysAgo) {
  // Date arithmetic on the calendar string avoids 23/25 hour DST days.
  return new Date(Date.parse(`${today}T00:00:00.000Z`) - daysAgo * 86_400_000)
    .toISOString().slice(0, 10);
}

function jobId(secret, ownerId, day, jid, attempt = 0) {
  const digest = createHmac('sha256', secret).update('suco-private-daily-v1\0')
    .update(ownerId).update('\0').update(day).update('\0').update(jid)
    .update('\0').update(String(attempt)).digest();
  const id = Buffer.from(digest.subarray(0, 16));
  id[6] = (id[6] & 0x0f) | 0x80;
  id[8] = (id[8] & 0x3f) | 0x80;
  const hex = id.toString('hex');
  id.fill(0); digest.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Runs only inside the measured worker, after the owner has released their key. */
export function createPrivateDaily({ ownerId, secret, metadata, messages, summaries,
  authorize, catalogVersion, syncing = () => false, now = () => new Date(),
  minMessages = 5, lookbackDays = 30, maxStartsPerRun = 3 }) {
  if (!/^[0-9a-f-]{36}$/i.test(ownerId) || !Buffer.isBuffer(secret) || secret.length !== 32 ||
      !catalogVersion || !Number.isInteger(minMessages) || minMessages < 1 ||
      !Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90 ||
      !Number.isInteger(maxStartsPerRun) || maxStartsPerRun < 1 || maxStartsPerRun > 10)
    throw Error('PRIVATE_DAILY_CONFIG');
  let closed = false;
  let inFlight = null;
  let interval = null;
  let first = null;

  async function run() {
    if (closed || inFlight) return inFlight ?? { skipped: true };
    inFlight = (async () => {
      if (syncing() || !await authorize()) return { skipped: true };
      const instant = now();
      if (clockParts(instant).hour < 8) return { skipped: true };
      const today = clockParts(instant).day;
      const [chats, all] = await Promise.all([metadata.chatList(), messages.snapshot()]);
      const tracked = chats.filter(chat => chat.tracked === true && chat.archived !== true);
      let started = 0, pending = 0, completed = 0;
      const byChatDay = new Map();
      for (const message of all) {
        const key = `${message.chat_jid}\0${clockParts(message.ts).day}`;
        const group = byChatDay.get(key) ?? [];
        group.push(message);
        byChatDay.set(key, group);
      }
      for (let daysAgo = 1; daysAgo <= lookbackDays && !closed; daysAgo++) {
        const day = previousLocalDay(today, daysAgo);
        for (const chat of tracked) {
          if (started >= maxStartsPerRun) return { started, pending, completed, backlog: true };
          if (closed || syncing() || !await authorize()) return { started, pending, completed, interrupted: true };
          if (chat.tracked_since && day < clockParts(new Date(chat.tracked_since)).day) continue;
          const selected = (byChatDay.get(`${chat.jid}\0${day}`) ?? [])
            .filter(message => !chat.tracked_since || message.ts >= new Date(chat.tracked_since))
            .sort((a, b) => a.ts - b.ts);
          if (selected.length < minMessages) continue;
          for (let attempt = 0; attempt < 3; attempt++) {
            const requestId = jobId(secret, ownerId, day, chat.jid, attempt);
            const state = await summaries.status(requestId);
            if (state.state === 'complete') { completed++; break; }
            if (state.state === 'pending') { pending++; break; }
            if (state.state === 'failed' && attempt < 2) continue;
            if (state.state === 'failed') { pending++; break; }
            await summaries.generateAutomatic({ request_id: requestId, chat_jid: chat.jid,
              start: selected[0].ts.toISOString(), end: selected.at(-1).ts.toISOString(),
              template_version: catalogVersion });
            started++;
            break;
          }
        }
      }
      return { started, pending, completed };
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    run,
    start() {
      if (closed || interval) throw Error('PRIVATE_DAILY_START');
      first = setTimeout(() => { void run().catch(() => {}); }, 10_000);
      interval = setInterval(() => { void run().catch(() => {}); }, 15 * 60_000);
    },
    close() {
      closed = true;
      if (first) clearTimeout(first);
      if (interval) clearInterval(interval);
      first = null; interval = null;
    },
  };
}
