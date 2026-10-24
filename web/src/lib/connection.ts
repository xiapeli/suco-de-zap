import type { Status } from './api';

export function isSyncUnverified(status: Status | undefined, now = Date.now()): boolean {
  if (!status?.connected) return false;
  const evidence = status.syncEvidence;
  if (evidence?.pendingInMemory || evidence?.writeHealth?.consecutiveWriteFailures) return true;
  if (evidence && !evidence.available) return true;
  if (status.syncing) return false;
  if (!evidence) return false;
  const savedAt = Date.parse(evidence.lastSavedMessageAt || '');
  const connectedAt = Date.parse(status.lastConnectedAt || '');
  // One successfully received message must not hide a later stall forever.
  if (Number.isFinite(savedAt) && now - savedAt > 24 * 60 * 60_000) return true;
  return !evidence.newMessageAfterConnect
    && Number.isFinite(connectedAt) && now - connectedAt > 5 * 60_000;
}

export function connectionView(status: Status | undefined, error = false) {
  if (error) return { state: 'unreachable', title: 'Não conseguimos atualizar sua conexão', description: 'Seus dados salvos continuam disponíveis quando o serviço voltar. Tente novamente.', action: 'Tentar novamente', tone: 'warning' };
  if (!status) return { state: 'loading', title: 'Verificando sua conexão', description: 'Só um instante.', action: '', tone: 'neutral' };
  if (status.connected) {
    if (isSyncUnverified(status))
      return { state: 'sync_unverified', title: 'Conectado, mas sem mensagem nova confirmada', description: 'As conversas salvas podem estar antigas. Envie uma mensagem em um grupo seu; se ela não aparecer, confira o pareamento.', action: 'Verificar sincronização', tone: 'warning' };
    return { state: 'connected', title: status.syncing ? 'Buscando suas conversas' : 'WhatsApp conectado', description: status.syncing ? 'Você pode continuar. As conversas aparecem conforme chegam.' : 'Acompanhamento somente de leitura.', action: '', tone: 'success' };
  }
  if (status.connectionState === 'action_required') return { state: 'action_required', title: 'Sua conexão precisa de atenção', description: 'Abra o WhatsApp no celular e confira se a conta está disponível. Depois, tente conectar novamente. Reconectar não resolve uma restrição aplicada à conta.', action: 'Ver orientação', tone: 'warning' };
  if (status.reason === 'qr_expired') return { state: 'qr_required', title: 'O QR venceu', description: 'Abra a conexão para gerar um QR novo. Seus dados salvos continuam disponíveis.', action: 'Gerar novo QR', tone: 'warning' };
  if (status.qr || status.connectionState === 'qr_required') return { state: 'qr_required', title: 'Conecte seu WhatsApp', description: 'Escaneie o QR para retomar a atualização. As conversas já salvas permanecem no seu espaço.', action: 'Conectar WhatsApp', tone: 'warning' };
  if (status.connectionState === 'reconnecting' || status.connectionState === 'connecting') return { state: 'reconnecting', title: 'Tentando recuperar a conexão', description: 'A atualização está pausada enquanto reconectamos. Você pode consultar o que já foi salvo.', action: 'Acompanhar conexão', tone: 'neutral' };
  return { state: 'disconnected', title: 'A atualização do WhatsApp está pausada', description: 'Reconecte para receber novas mensagens. Seu histórico salvo permanece disponível.', action: 'Reconectar WhatsApp', tone: 'warning' };
}
