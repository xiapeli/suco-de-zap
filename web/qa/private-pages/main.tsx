import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PrivateLayoutContext } from '@/components/AppLayout';
import { installPrivateLegacyBridge } from '@/lib/private-legacy-bridge';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import Dashboard from '@/pages/Dashboard';
import Conversations from '@/pages/Conversations';
import Summaries from '@/pages/Summaries';
import MyJuiceTypes from '@/pages/MyJuiceTypes';
import Digest from '@/pages/Digest';
import Guide from '@/pages/Guide';
import Onboarding from '@/pages/Onboarding';
import Settings from '@/pages/Settings';
import '@/index.css';
import '@/styles/suco-theme.css';

const accountId = '11111111-1111-4111-8111-111111111111';
const chat = { jid: 'synthetic@g.us', name: 'Grupo sintético', is_group: true, tracked: false,
  archived: false, message_count: 12, last_message_at: '2026-10-22T16:00:00.000Z',
  last_message_preview: 'Combinamos a data.' };
const summary = { id: '22222222-2222-4222-8222-222222222222', chat_jid: chat.jid,
  chat_name: chat.name, title: 'Suco do grupo sintético', analysis_type: 'general',
  period_start: '2026-10-22T10:00:00.000Z', period_end: '2026-10-22T16:00:00.000Z',
  content: '## Resumo\nCombinamos a data em um grupo sintético.', model: 'glm-5.3-flash',
  auto: false, created_at: '2026-10-22T16:30:00.000Z' };
const calls: string[] = [];
(window as Window & { __qaCalls?: string[] }).__qaCalls = calls;
const qaWindow = window as Window & { __qaDisconnected?: boolean; __qaUnverified?: boolean; __qaQr?: boolean };
const channel = { async rpc(method: string, path: string, request?: Record<string, unknown>) {
  calls.push(`${method} ${path}`);
  const url = new URL(path, 'https://worker.internal');
  let body: object;
  if (url.pathname === '/api/status') body = { connected: !qaWindow.__qaDisconnected,
    qr: qaWindow.__qaQr ? 'synthetic-qr-for-render-only' : null,
    lastConnectedAt: '2026-10-22T16:00:00.000Z',
    me: { jid: '5511000000000@s.whatsapp.net', name: 'Conta sintética' }, syncing: false,
    connectionState: qaWindow.__qaDisconnected ? 'disconnected' : 'connected',
    syncEvidence: { available: true, newMessageAfterConnect: !qaWindow.__qaDisconnected && !qaWindow.__qaUnverified,
      lastSavedMessageAt: '2026-10-22T16:00:00.000Z', lastIngestedAt: '2026-10-22T16:01:00.000Z' } };
  else if (url.pathname === '/api/usage') body = { available: false };
  else if (url.pathname === '/api/dashboard') body = { chats: 1, messages: 12, summaries: 1,
    tracked: 0, last_message_at: chat.last_message_at, connected: true };
  else if (url.pathname === '/api/chats') body = { chats: [chat], total: 1 };
  else if (url.pathname.endsWith('/stats')) body = { count: 12, first: '2026-10-22T10:00:00.000Z',
    last: '2026-10-22T16:00:00.000Z', by_sender: [{ sender_name: 'Pessoa sintética', count: 12 }] };
  else if (url.pathname.endsWith('/name')) body = { name: chat.name };
  else if (url.pathname === '/api/summaries') body = { summaries: [summary], total: 1 };
  else if (url.pathname === `/api/summaries/${summary.id}`) body = { summary };
  else if (url.pathname === '/api/private/personal-juices') body = { types: [] };
  else if (url.pathname === '/api/digests') body = { digests: [], total: 0 };
  else if (url.pathname === '/api/juice-catalog') body = { version: 'suco-17-v1', personalTypes: true, types: [] };
  else if (url.pathname === '/api/private/chats/tracking') {
    if (request?.jid !== chat.jid || typeof request?.tracked !== 'boolean')
      return { status: 400, body: { code: 'QA_TRACKING_INPUT' } };
    chat.tracked = request.tracked;
    body = { chat };
  }
  else if (url.pathname === '/api/connection/reconnect') { qaWindow.__qaQr = true; body = { ok: true }; }
  else return { status: 404, body: { code: 'QA_UNHANDLED_ROUTE' } };
  return { status: 200, body };
} } as unknown as ConfidentialChannel;
installPrivateLegacyBridge(channel, accountId, 'owner');
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={queryClient}>
  <MemoryRouter initialEntries={['/']}>
    <PrivateLayoutContext.Provider value={{ email: 'qa@example.test', onSignOut: async () => {} }}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/create" element={<Conversations />} />
        <Route path="/conversations" element={<Conversations />} />
        <Route path="/summaries" element={<Summaries />} />
        <Route path="/my-juices" element={<MyJuiceTypes />} />
        <Route path="/my-juices/:id" element={<MyJuiceTypes />} />
        <Route path="/digest" element={<Digest />} />
        <Route path="/guide" element={<Guide />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </PrivateLayoutContext.Provider>
  </MemoryRouter>
</QueryClientProvider></StrictMode>);
