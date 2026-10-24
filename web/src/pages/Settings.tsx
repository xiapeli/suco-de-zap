import { connectionView } from '@/lib/connection';
import React, { useContext, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { api, getApiUrl } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';
import { AppLayout, PrivateLayoutContext } from '@/components/AppLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { Switch } from '@/components/ui/switch';
import {
  Smartphone,
  Server,
  LogOut,
  Unplug,
  Wifi,
  WifiOff,
  RefreshCw,
  AlertTriangle,
  ScanSearch,
  Lock,
  Tags,
} from 'lucide-react';
import { ApiError } from '@/lib/api';

const formatJid = (jid: string) => {
  const number = jid.split('@')[0];
  return number.startsWith('55') && number.length >= 12
    ? `+${number.slice(0, 2)} (${number.slice(2, 4)}) ${number.slice(4)}`
    : `+${number}`;
};

const ExtractionSettingsCard = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmDisable, setConfirmDisable] = useState<{ kind: string; label: string; count: number } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['extraction-settings'],
    queryFn: api.extractionSettings,
  });

  // Sonda o endpoint de tags: backend antigo (404) => recurso indisponível, nada aparece.
  const tagsProbe = useQuery({
    queryKey: ['fact-tags', 'probe'],
    queryFn: () => api.factTags(),
    retry: false,
  });

  // Amostra de fatos para detectar itens ainda sem subcategorias (tags).
  const factsSample = useQuery({
    queryKey: ['facts', 'untagged-sample'],
    queryFn: () => api.facts({ limit: 100 }),
    enabled: tagsProbe.isSuccess,
  });

  const untaggedCount = (factsSample.data?.facts ?? []).filter(
    (f) => !f.tags || f.tags.length === 0,
  ).length;

  const retagMutation = useMutation({
    mutationFn: () => api.retagFacts(),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['facts'] });
      queryClient.invalidateQueries({ queryKey: ['fact-tags'] });
      toast({
        title: 'Recategorização concluída',
        description: `${r.retagged} ${r.retagged === 1 ? 'fato recebeu' : 'fatos receberam'} novas tags (${r.scanned} analisados).`,
      });
    },
    onError: (error) => {
      const notSupported = error instanceof ApiError && error.status === 404;
      toast({
        title: 'Erro ao recategorizar',
        description: notSupported
          ? 'O servidor ainda não suporta recategorização. Atualize o backend.'
          : error instanceof Error
            ? error.message
            : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ kind, enabled }: { kind: string; enabled: boolean }) =>
      api.updateExtractionSetting(kind, enabled),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['extraction-settings'] });
      queryClient.invalidateQueries({ queryKey: ['facts'] });
      if (!vars.enabled) {
        toast({
          title: 'Categoria desligada',
          description: 'Os fatos já extraídos dessa categoria foram apagados.',
        });
      }
    },
    onError: (error) => {
      toast({
        title: 'Erro ao atualizar categoria',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  const settings = settingsQuery.data?.settings ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScanSearch className="h-5 w-5" />
          Extração de dados
        </CardTitle>
        <CardDescription>
          O Cofre indexa as categorias ligadas aqui. Desligar uma categoria remove os fatos extraídos
          dessa categoria. Categorias sensíveis (<Lock className="h-3 w-3 inline" />) usam referências
          no Cofre; isso não impede que o texto original das mensagens seja sincronizado e armazenado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        {settingsQuery.isLoading && <Skeleton className="h-40 w-full rounded-lg" />}
        {settings.map((s) => (
          <div key={s.kind} className="flex items-center justify-between rounded-lg border p-3">
            <div className="flex items-center gap-2 min-w-0">
              {s.pointer_only && <Lock className="h-4 w-4 text-amber-600 shrink-0" />}
              <div className="min-w-0">
                <p className="font-medium text-sm truncate">{s.label}</p>
                <p className="text-xs text-muted-foreground">
                  {s.count} {s.count === 1 ? 'fato' : 'fatos'}
                  {s.pointer_only && ' · só ponteiro, valor nunca é armazenado'}
                </p>
              </div>
            </div>
            <Switch
              checked={s.enabled}
              disabled={toggleMutation.isPending}
              onCheckedChange={(checked) => {
                if (!checked && s.count > 0) {
                  setConfirmDisable({ kind: s.kind, label: s.label, count: s.count });
                } else {
                  toggleMutation.mutate({ kind: s.kind, enabled: checked });
                }
              }}
            />
          </div>
        ))}

        {tagsProbe.isSuccess && untaggedCount > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border border-dashed p-3 !mt-3">
            <p className="text-xs text-muted-foreground">
              {untaggedCount === 1
                ? 'Há 1 fato antigo ainda sem subcategorias (tags).'
                : `Há fatos antigos ainda sem subcategorias (tags) — pelo menos ${untaggedCount}.`}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => retagMutation.mutate()}
              disabled={retagMutation.isPending}
            >
              {retagMutation.isPending ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Tags className="h-3.5 w-3.5 mr-1.5" />
              )}
              {retagMutation.isPending ? 'Recategorizando…' : 'Recategorizar fatos antigos'}
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!confirmDisable} onOpenChange={(open) => !open && setConfirmDisable(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desligar "{confirmDisable?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Os {confirmDisable?.count} fatos já extraídos dessa categoria serão apagados do
              índice. As mensagens originais no WhatsApp não são afetadas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmDisable) {
                  toggleMutation.mutate({ kind: confirmDisable.kind, enabled: false });
                  setConfirmDisable(null);
                }
              }}
            >
              Desligar e apagar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};

const ProcessingUsageCard = () => {
  const usage = useQuery({ queryKey: ['usage'], queryFn: api.usage, retry: false, refetchInterval: 15_000 });
  const data = usage.data;
  if (data && 'available' in data && data.available === false) return null;
  const quota = data && 'monthlyUsed' in data ? data : null;
  const trialAccess = quota?.access === 'trial' || quota?.access === 'trial_exhausted';
  const unlimited = quota?.access === 'owner' && quota.unlimited === true;
  const valid = quota && [quota.monthlyUsed, quota.dailyUsed, quota.monthlyLimit, quota.dailyLimit, quota.monitoredLimit].every(value => Number.isSafeInteger(value) && value >= 0);
  return <Card>
    <CardHeader><CardTitle>{trialAccess ? 'Seus sucos grátis' : unlimited ? 'Uso do parceiro' : quota?.access === 'owner' ? 'Uso do proprietário' : 'Processamentos de IA'}</CardTitle><CardDescription>{trialAccess ? '3 resumos manuais por conta, sem cartão e sem renovação mensal.' : unlimited ? 'Acesso completo e ilimitado. As contagens ajudam você a acompanhar seu espaço.' : 'Acompanhe o uso do seu espaço. A cota conta análises, não mensagens sincronizadas.'}</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      {usage.isPending ? <p role="status" className="text-sm text-muted-foreground">Conferindo seu uso…</p> : usage.isError || !valid ? <div role="status" className="space-y-3"><p className="text-sm text-muted-foreground">Não conseguimos atualizar suas cotas agora. Isso não muda o limite da sua conta.</p><Button variant="outline" disabled={usage.isFetching} onClick={() => usage.refetch()}>Atualizar uso</Button></div> : quota && trialAccess && quota.trial ? <>
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="rounded-lg border p-4"><dt className="text-sm text-muted-foreground">Sucos concluídos</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{quota.trial.completed} de {quota.trial.limit}</dd></div><div className="rounded-lg border p-4"><dt className="text-sm text-muted-foreground">Disponíveis</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{quota.trial.remaining}</dd></div></dl>
        <p className="text-sm text-muted-foreground">Só resumos concluídos usam seus sucos grátis. Falhas não gastam a cota. {quota.trial.reserved > 0 ? `${quota.trial.reserved} pedido(s) aguardam processamento ou confirmação.` : ''}</p>
        <p className="text-sm text-muted-foreground">O teste inclui resumos manuais. Automação, digest, extração de fatos e busca no Cofre fazem parte da assinatura. A cota gratuita é por conta e não renova todo mês.</p>
        {quota.access === 'trial_exhausted' && <p role="status" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-950">O teste foi concluído. Seus resumos salvos continuam disponíveis; novas sincronizações e análises ficam pausadas até a assinatura.</p>}
        <Button asChild variant="outline"><Link to="/account">{quota.access === 'trial_exhausted' ? 'Conhecer a assinatura' : 'Minha conta'}</Link></Button>
      </> : quota && <>
        {quota.access === 'owner' && <p className="text-sm text-emerald-800">{unlimited?'Acesso completo de parceiro, sem cobrança e sem cota comercial de processamentos.':'Acesso de proprietário, sem assinatura.'}</p>}
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="rounded-lg border p-4"><dt className="text-sm text-muted-foreground">Neste mês</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{quota.monthlyUsed.toLocaleString('pt-BR')} <span className="text-sm font-normal text-muted-foreground">{unlimited?'processamentos · ilimitado':`de ${quota.monthlyLimit.toLocaleString('pt-BR')} processamentos`}</span></dd></div><div className="rounded-lg border p-4"><dt className="text-sm text-muted-foreground">Hoje</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{quota.dailyUsed.toLocaleString('pt-BR')} <span className="text-sm font-normal text-muted-foreground">{unlimited?'processamentos · ilimitado':`de ${quota.dailyLimit.toLocaleString('pt-BR')} processamentos`}</span></dd></div></dl>
        {!unlimited&&(quota.monthlyUsed >= quota.monthlyLimit || quota.dailyUsed >= quota.dailyLimit) && <p role="status" className="rounded-lg bg-amber-50 p-4 text-sm text-amber-950">Você atingiu uma das cotas de processamento. Aguarde a renovação dessa cota para iniciar novas análises.</p>}
        <p className="text-sm text-muted-foreground">{unlimited?'Resumos, extração e classificação de fatos e digests entram no relatório de uso, sem cota comercial.':'Resumos, extração e classificação de fatos e digests usam essa cota.'} A busca local nas mensagens não chama IA e não gasta processamentos. Cada chamada de análise conta como um processamento; uma tarefa extensa pode precisar de mais de uma chamada.</p>
        <p className="text-sm text-muted-foreground">{unlimited?`Período do relatório: ${quota.period}. As contagens continuam disponíveis para você acompanhar o uso.`:`Período mensal: ${quota.period}. A cota diária renova às 00h UTC. A mensal, no primeiro dia do mês, às 00h UTC.`}</p>
        <p className="text-sm text-muted-foreground">{unlimited?'Você pode acompanhar conversas sem a cota comercial do plano. Escolha quais deseja acompanhar em Conversas.':`Até ${quota.monitoredLimit.toLocaleString('pt-BR')} conversas com resumo automático. Esse limite controla o acompanhamento automático; ele não limita quais conversas da conta são sincronizadas.`}</p>
      </>}
    </CardContent>
  </Card>;
};

const LegacySettings = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { logout } = useAuth();
  const [confirmExit, setConfirmExit] = useState(false);

  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 3000,
  });

  const disconnectMutation = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast({
        title: 'WhatsApp desconectado',
        description: 'As credenciais foram apagadas. Escaneie o QR code para parear de novo.',
      });
    },
    onError: (error) => {
      toast({
        title: 'Erro ao desconectar',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  const status = statusQuery.data;
  const connection = connectionView(status, statusQuery.isError);

  const handleExit = () => {
    logout();
    navigate('/auth', { replace: true });
  };

  return (
    <AppLayout title="Configurações">
      <div className="space-y-6 max-w-2xl">
        {/* Conexão WhatsApp */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Smartphone className="h-5 w-5" />
              Conexão WhatsApp
            </CardTitle>
            <CardDescription>
              Acompanhe sua conexão. O Suco usa seu WhatsApp somente para leitura.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {statusQuery.isLoading && <Skeleton className="h-24 w-full rounded-lg" />}

            {statusQuery.isError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Servidor inacessível</AlertTitle>
                <AlertDescription>
                  O serviço não respondeu agora. Sua sessão no WhatsApp não foi apagada. Tente novamente ou acompanhe a conexão pelos primeiros passos.
                </AlertDescription>
              </Alert>
            )}

            {status?.connected && (
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="flex items-center gap-3">
                    <Wifi className="h-5 w-5 text-emerald-600" />
                    <div>
                      <p className="font-medium">{status.me?.name || 'Conectado'}</p>
                      {status.me && (
                        <p className="text-sm text-muted-foreground">{formatJid(status.me.jid)}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {status.syncing && (
                      <Badge variant="secondary" className="bg-blue-100 text-blue-800">
                        <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                        Sincronizando
                      </Badge>
                    )}
                    <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">
                      Conectado
                    </Badge>
                  </div>
                </div>

                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" className="text-destructive">
                      <Unplug className="h-4 w-4 mr-2" />
                      Desconectar WhatsApp
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Desconectar o WhatsApp?</AlertDialogTitle>
                      <AlertDialogDescription>
                        O servidor vai desconectar e apagar as credenciais de pareamento. A
                        sincronização de mensagens para até você escanear o QR code de novo.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancelar</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        onClick={() => disconnectMutation.mutate()}
                      >
                        {disconnectMutation.isPending ? 'Desconectando...' : 'Desconectar'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}

            {status && !status.connected && status.qr && (
              <div className="text-center space-y-4 py-4">
                <p className="font-medium">Escaneie o QR code com o WhatsApp</p>
                <div className="inline-block bg-white p-4 rounded-lg border">
                  <QRCodeSVG value={status.qr} size={256} className="max-w-full h-auto" />
                </div>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho. Use o QR atual. Se ele expirar, abra Conectar WhatsApp no menu para pedir outro.
                </p>
              </div>
            )}

            {status && !status.connected && !status.qr && (
              <div className="flex items-center gap-3 rounded-lg border p-4">
                <WifiOff className="h-5 w-5 text-red-500" />
                <div>
                  <p className="font-medium">{connection.title}</p>
                  <p className="text-sm text-muted-foreground">{connection.description}</p>
                  <Button variant="outline" className="mt-4" onClick={() => navigate("/onboarding?reconnect=1")}>{connection.action || "Acompanhar conexão"}</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <ProcessingUsageCard />

        {/* Extração de dados (Cofre) */}
        <ExtractionSettingsCard />

        {/* Servidor */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              Servidor
            </CardTitle>
            <CardDescription>Conexão do cockpit com o backend.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border p-4 space-y-1">
              <p className="text-sm text-muted-foreground">URL da API</p>
              <p className="font-mono text-sm">{getApiUrl()}</p>
            </div>

            <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
              <AlertDialogTrigger asChild>
                <Button variant="outline">
                  <LogOut className="h-4 w-4 mr-2" />
                  Sair do cockpit
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Sair do cockpit?</AlertDialogTitle>
                  <AlertDialogDescription>
                    O token da API será removido deste navegador. O servidor e a sincronização do
                    WhatsApp continuam rodando normalmente.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction onClick={handleExit}>Sair</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
};

function PrivateSettings() {
  const account = useContext(PrivateLayoutContext);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ['status'], queryFn: api.status, retry: false,
    refetchInterval: 5000, refetchOnWindowFocus: true });
  const reconnect = useMutation({ mutationFn: api.reconnect,
    onSuccess: () => { void statusQuery.refetch(); void queryClient.invalidateQueries({ queryKey: ['chats'] }); } });
  const freshPairing = useMutation({ mutationFn: api.newPairing,
    onSuccess: () => { void statusQuery.refetch(); void queryClient.invalidateQueries({ queryKey: ['chats'] }); } });
  const [confirmPairing, setConfirmPairing] = useState(false);
  const status = statusQuery.data;
  const connection = connectionView(status, statusQuery.isError);
  const blocked = status?.pairingError === 'PAIRING_IDENTITY_UNAVAILABLE' || status?.reason === 'forbidden';
  const needsPairing = status?.pairingError === 'PAIRING_ACCOUNT_MISMATCH' ||
    ['bad_session', 'multidevice_mismatch', 'logged_out'].includes(status?.reason ?? '');
  return <AppLayout title="Configurações"><div className="space-y-6 max-w-2xl">
    <Card><CardHeader><CardTitle className="flex items-center gap-2"><Smartphone className="h-5 w-5" />Conexão WhatsApp</CardTitle>
      <CardDescription>Acompanhe sua conexão. O Suco usa seu WhatsApp somente para leitura.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {statusQuery.isPending && <Skeleton className="h-24 w-full rounded-lg" />}
        {statusQuery.isError && <Alert variant="destructive"><AlertTriangle className="h-4 w-4" />
          <AlertTitle>Conexão indisponível</AlertTitle><AlertDescription>O serviço não respondeu agora. Sua sessão no WhatsApp foi preservada.</AlertDescription></Alert>}
        {status?.connected && <div className="flex items-center justify-between rounded-lg border p-4 gap-3">
          <div className="flex items-center gap-3 min-w-0"><Wifi className="h-5 w-5 text-emerald-600 shrink-0" />
            <div className="min-w-0"><p className="font-medium truncate">{status.me?.name || 'Conectado'}</p>
              <p className="text-sm text-muted-foreground">{status.syncEvidence?.newMessageAfterConnect ?
                'Mensagem nova salva após a conexão.' : 'Aguardando mensagem nova para confirmar a atualização.'}</p></div></div>
          <Badge variant="secondary" className="bg-emerald-100 text-emerald-800">Conectado</Badge></div>}
        {status?.syncEvidence && <p className="text-sm text-muted-foreground">Última mensagem salva: {status.syncEvidence.lastIngestedAt ?
          new Date(status.syncEvidence.lastIngestedAt).toLocaleString('pt-BR') : 'ainda não confirmada'}.
          {status.syncEvidence.pendingInMemory ? ` ${status.syncEvidence.pendingInMemory} aguardando gravação.` : ''}</p>}
        {!!status?.syncEvidence?.pendingInMemory && !status.syncEvidence.recoveryDurable &&
          <p className="text-sm text-destructive" role="alert">A gravação está indisponível agora. As mensagens em espera ainda não sobreviveriam a um reinício. Confira novamente antes de confiar na sincronização.</p>}
        {status && !status.connected && status.qr && <div className="text-center space-y-4 py-4">
          <p className="font-medium">Escaneie o QR code com o WhatsApp</p>
          <div className="inline-block bg-white p-4 rounded-lg border"><QRCodeSVG value={status.qr} size={256} className="max-w-full h-auto" /></div>
          <p className="text-sm text-muted-foreground">No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho.</p></div>}
        {status && !status.connected && !status.qr && <div className="flex items-center gap-3 rounded-lg border p-4">
          <WifiOff className="h-5 w-5 text-red-500 shrink-0" /><div><p className="font-medium">{connection.title}</p>
            <p className="text-sm text-muted-foreground">{connection.description}</p></div></div>}
        {status && <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={statusQuery.isFetching} onClick={() => { void statusQuery.refetch(); void queryClient.invalidateQueries({ queryKey: ['chats'] }); }}>
            <RefreshCw className="h-4 w-4 mr-2" />Atualizar mensagens</Button>
          {!blocked && <Button variant="outline" disabled={reconnect.isPending} onClick={() => reconnect.mutate()}>
            <RefreshCw className="h-4 w-4 mr-2" />{reconnect.isPending ? 'Reconectando…' : 'Tentar sincronizar'}</Button>}
          <Button variant="outline" onClick={() => navigate('/onboarding?reconnect=1')}>Conferir conexão e QR</Button></div>}
        {needsPairing && !blocked && <div className="rounded-lg border p-4 space-y-3"><label className="flex gap-2 text-sm">
          <input type="checkbox" checked={confirmPairing} onChange={event => setConfirmPairing(event.target.checked)} />
          Vou ler o novo QR com o mesmo WhatsApp desta conta.</label>
          <Button disabled={!confirmPairing || freshPairing.isPending} onClick={() => freshPairing.mutate()}>
            {freshPairing.isPending ? 'Preparando…' : 'Preparar novo pareamento'}</Button></div>}
        {(reconnect.isError || freshPairing.isError) && <p role="alert" className="text-sm text-destructive">Não conseguimos atualizar a conexão. Seus dados continuam preservados.</p>}
      </CardContent></Card>
    <Card><CardHeader><CardTitle>Seu espaço</CardTitle><CardDescription>Esta conta e a chave usada para abrir os dados privados.</CardDescription></CardHeader>
      <CardContent className="space-y-4"><p className="text-sm">{account?.email ?? 'Sua conta'}</p>
        <Button variant="outline" onClick={() => void account?.onSignOut()}>Sair e remover chave deste navegador</Button></CardContent></Card>
  </div></AppLayout>;
}

export default function Settings() {
  return import.meta.env.VITE_SUCO_CONTROL === 'supabase' ? <PrivateSettings /> : <LegacySettings />;
}
