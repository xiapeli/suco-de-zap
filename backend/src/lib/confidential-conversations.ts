import type { StagedMessage } from './ingestion-spool.js';

export interface PrivateChatMetadata { jid: string; name: string | null; is_group: boolean;
  tracked?: boolean; archived?: boolean }
export interface PrivateContactMetadata { jid: string; name: string | null; notify: string | null }
export interface PrivateLidMetadata { lid: string; pn: string }
export interface PrivateChatView {
  jid: string;
  name: string;
  phone: string | null;
  is_group: boolean;
  tracked: boolean;
  archived: boolean;
  last_message_at: Date | null;
  message_count: number;
  last_message_preview: string | null;
}

/** All inputs are already decrypted inside the confidential worker. */
export function privateChatViews(
  messages: StagedMessage[],
  chats: PrivateChatMetadata[],
  contacts: PrivateContactMetadata[],
  lids: PrivateLidMetadata[],
  formatPhone: (jid: string) => string | null,
): PrivateChatView[] {
  const contactByJid = new Map(contacts.map((contact) => [contact.jid, contact]));
  const pnByLid = new Map(lids.map((row) => [row.lid, row.pn]));
  const aggregate = new Map<string, { count: number; latest: StagedMessage | null; senderName: string | null; senderTs: Date | null }>();
  for (const message of messages) {
    const item = aggregate.get(message.chat_jid) ?? { count: 0, latest: null, senderName: null, senderTs: null };
    item.count++;
    if (!item.latest || message.ts > item.latest.ts ||
        (message.ts.valueOf() === item.latest.ts.valueOf() && message.id > item.latest.id)) item.latest = message;
    if (!message.from_me && message.sender_name && (!item.senderTs || message.ts >= item.senderTs)) {
      item.senderName = message.sender_name;
      item.senderTs = message.ts;
    }
    aggregate.set(message.chat_jid, item);
  }
  const metadata = new Map(chats.map((chat) => [chat.jid, chat]));
  for (const jid of aggregate.keys()) {
    if (!metadata.has(jid)) metadata.set(jid, { jid, name: null, is_group: jid.endsWith('@g.us') });
  }
  const views: PrivateChatView[] = [];
  for (const chat of metadata.values()) {
    const item = aggregate.get(chat.jid);
    const pn = pnByLid.get(chat.jid) ?? chat.jid;
    const contact = contactByJid.get(chat.jid) ?? contactByJid.get(pn);
    const phone = formatPhone(pn);
    const latest = item?.latest;
    views.push({
      jid: chat.jid,
      name: chat.name || contact?.name || contact?.notify || item?.senderName || phone || chat.jid.split('@')[0],
      phone,
      is_group: chat.is_group,
      tracked: chat.tracked === true,
      archived: chat.archived === true,
      last_message_at: latest?.ts ?? null,
      message_count: item?.count ?? 0,
      last_message_preview: latest ? (latest.body ?? `[${latest.msg_type}]`) : null,
    });
  }
  return views.sort((a, b) => (b.last_message_at?.valueOf() ?? -Infinity) -
    (a.last_message_at?.valueOf() ?? -Infinity) || a.jid.localeCompare(b.jid));
}

export function privateChatPage(views: PrivateChatView[], options: {
  kind: 'all' | 'group' | 'person'; q?: string; limit: number; offset: number;
}): { chats: PrivateChatView[]; total: number } {
  const q = options.q?.trim().toLocaleLowerCase('pt-BR');
  const filtered = views.filter((chat) => {
    if (chat.archived || (options.kind === 'group' ? !chat.is_group : !chat.message_count ||
        (options.kind === 'person' && chat.is_group))) return false;
    return !q || [chat.name, chat.jid, chat.phone].some((value) =>
      value?.toLocaleLowerCase('pt-BR').includes(q));
  });
  return { chats: filtered.slice(options.offset, options.offset + options.limit), total: filtered.length };
}

export function privateMessagePage(messages: StagedMessage[], options: {
  jid: string; start: Date; end: Date; limit: number; offset: number;
}) {
  const selected = messages.filter((message) => message.chat_jid === options.jid &&
    message.ts >= options.start && message.ts <= options.end)
    .sort((a, b) => a.ts.valueOf() - b.ts.valueOf() || a.id.localeCompare(b.id));
  return { messages: selected.slice(options.offset, options.offset + options.limit).map((message) => ({
    chat_jid: message.chat_jid, id: message.id, sender_jid: message.sender_jid,
    sender_name: message.sender_name, from_me: message.from_me, body: message.body,
    msg_type: message.msg_type, timestamp: message.ts,
  })), total: selected.length };
}

export function privateChatStats(messages: StagedMessage[], jid: string, start: Date, end: Date) {
  let count = 0;
  let first: Date | null = null;
  let last: Date | null = null;
  const senders = new Map<string, number>();
  for (const message of messages) {
    if (message.chat_jid !== jid || message.ts < start || message.ts > end) continue;
    count++;
    if (!first || message.ts < first) first = message.ts;
    if (!last || message.ts > last) last = message.ts;
    const sender = message.sender_name || (message.from_me ? 'Eu' : (message.sender_jid ?? '').split('@')[0]);
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
  }
  const by_sender = [...senders].map(([sender_name, total]) => ({ sender_name, count: total }))
    .sort((a, b) => b.count - a.count || a.sender_name.localeCompare(b.sender_name)).slice(0, 20);
  return { count, first, last, by_sender };
}
