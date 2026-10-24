import type { ConfidentialMessageStore } from './confidential-message-store.js';
import type { ConfidentialMetadataStore } from './confidential-metadata-store.js';

export interface PrivateSearchInput {
  query: string; chat_jid?: string; kind?: 'all' | 'pix' | 'email' | 'phone' | 'address';
  start?: string; end?: string; limit?: number; offset?: number;
}

const markers = {
  pix: /\bpix\b|\bchave\s+(?:pix|aleat[oó]ria)\b|\btransfer[êe]ncia\b/i,
  email: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  phone: /(?:\+?55[\s().-]*)?(?:\(?\d{2}\)?[\s().-]*)?9?\d{4}[\s.-]*\d{4}\b/,
  address: /\b(?:rua|avenida|av\.|travessa|alameda|estrada|cep)\b/i,
};

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

export function createConfidentialSearch(messages: ConfidentialMessageStore,
  metadata: ConfidentialMetadataStore) {
  return async (input: PrivateSearchInput) => {
    if (!input || typeof input.query !== 'string' || input.query.length > 500 ||
        (input.chat_jid !== undefined && (typeof input.chat_jid !== 'string' || input.chat_jid.length > 256)) ||
        !['all', 'pix', 'email', 'phone', 'address'].includes(input.kind ?? 'all') ||
        !Number.isInteger(input.limit ?? 30) || (input.limit ?? 30) < 1 || (input.limit ?? 30) > 100 ||
        !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0 || (input.offset ?? 0) > 100_000 ||
        (input.start !== undefined && !Number.isFinite(Date.parse(input.start))) ||
        (input.end !== undefined && !Number.isFinite(Date.parse(input.end))))
      throw Object.assign(new Error('PRIVATE_SEARCH_INPUT'), { code: 'PRIVATE_SEARCH_INPUT', status: 400 });
    const query = normalize(input.query.trim());
    const kind = input.kind ?? 'all';
    if (!query && kind === 'all')
      throw Object.assign(new Error('PRIVATE_SEARCH_INPUT'), { code: 'PRIVATE_SEARCH_INPUT', status: 400 });
    const [all, chats] = await Promise.all([messages.snapshot(), metadata.chatList()]);
    const names = new Map(chats.map(chat => [chat.jid, chat.name || 'Conversa']));
    const from = input.start ? Date.parse(input.start) : -Infinity;
    const until = input.end ? Date.parse(input.end) : Infinity;
    if (from > until) throw Object.assign(new Error('PRIVATE_SEARCH_INPUT'), { code: 'PRIVATE_SEARCH_INPUT', status: 400 });
    const inScope = all.filter(message => (!input.chat_jid || message.chat_jid === input.chat_jid) &&
      message.ts.valueOf() >= from && message.ts.valueOf() <= until);
    const matched = inScope.filter(message => {
      const body = message.body || '';
      return (kind === 'all' || markers[kind].test(body)) && (!query || normalize(body).includes(query));
    }).sort((a, b) => b.ts.valueOf() - a.ts.valueOf());
    const offset = input.offset ?? 0;
    const page = matched.slice(offset, offset + (input.limit ?? 30)).map(message => ({
      id: message.id, chat_jid: message.chat_jid, chat_name: names.get(message.chat_jid) || 'Conversa',
      sender_name: message.sender_name || (message.from_me ? 'Eu' : 'Participante'),
      ts: message.ts.toISOString(), body: (message.body || `[${message.msg_type}]`).slice(0, 3000),
      bodyTruncated: (message.body?.length ?? 0) > 3000,
    }));
    let first = Infinity, last = -Infinity;
    for (const message of all) {
      const value = message.ts.valueOf();
      if (Number.isFinite(value)) { first = Math.min(first, value); last = Math.max(last, value); }
    }
    return {
      messages: page, total: matched.length, nextOffset: offset + page.length < matched.length ? offset + page.length : null,
      coverage: { firstMessageAt: Number.isFinite(first) ? new Date(first).toISOString() : null,
        lastMessageAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
        totalMessages: all.length, selectedMessages: inScope.length, matchingMessages: matched.length,
        scope: 'stored_messages', historyComplete: false },
    };
  };
}
