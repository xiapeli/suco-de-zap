import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Digest as DigestType } from '@/lib/api';
import { cn } from '@/lib/utils';
import { AppLayout } from '@/components/AppLayout';
import SummaryMarkdown from '@/components/SummaryMarkdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import {
  Newspaper,
  RefreshCw,
  AlertTriangle,
  MessagesSquare,
  MessageCircle,
  Mic,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
} from 'lucide-react';
import { format, parseISO, isToday, isYesterday } from 'date-fns';
import { ptBR } from 'date-fns/locale';

// ---------- datas ----------

const dayTitle = (day: string) => {
  const date = parseISO(day.slice(0, 10));
  const full = format(date, "dd 'de' MMMM", { locale: ptBR });
  if (isToday(date)) return `Hoje · ${full}`;
  if (isYesterday(date)) return `Ontem · ${full}`;
  const weekday = format(date, "EEEE, dd 'de' MMMM", { locale: ptBR });
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
};

const dayChipLabel = (day: string) => {
  const date = parseISO(day);
  if (isToday(date)) return 'hoje';
  if (isYesterday(date)) return 'ontem';
  return format(date, 'EEE dd/MM', { locale: ptBR }).replace('.', '');
};

// O modelo escreve "Por conversa" com uma linha por chat, sem linha em branco
// entre elas — o markdown colaria tudo num parágrafo só. Separa aqui.
const prepareDigestContent = (raw: string) => {
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const isChatLine = /^\*\*[^*]/.test(line.trim());
    if (isChatLine && out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    out.push(line);
  }
  return out.join('\n');
};

// ---------- linha rolável com fade (mesma linguagem do Cofre) ----------

const ScrollRow = ({ children, fade = 'card' }: { children: React.ReactNode; fade?: 'card' | 'background' }) => (
  <div className="relative min-w-0">
    <div className="flex items-center gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
    <div
      className={cn(
        'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent',
        fade === 'card' ? 'from-card' : 'from-background',
      )}
    />
  </div>
);

// ---------- página ----------

const Digest = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const activeChipRef = useRef<HTMLButtonElement | null>(null);

  const digestsQuery = useQuery({
    queryKey: ['digests'],
    queryFn: () => api.digests({ limit: 60 }),
  });

  const generateMutation = useMutation({
    mutationFn: () => api.generateDigest(),
    onSuccess: ({ digest }) => {
      queryClient.invalidateQueries({ queryKey: ['digests'] });
      setSelectedDay(digest.day.slice(0, 10));
      toast({
        title: 'Digest pronto',
        description: `O dia ${format(parseISO(digest.day.slice(0, 10)), 'dd/MM/yyyy')} foi consolidado.`,
      });
    },
    onError: (error) => {
      toast({
        title: 'Erro ao gerar digest',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  const digests = digestsQuery.data?.digests ?? [];
  const current: DigestType | undefined = selectedDay
    ? digests.find((d) => d.day.slice(0, 10) === selectedDay)
    : digests[0];
  const currentDay = current?.day.slice(0, 10);

  const currentIndex = currentDay
    ? digests.findIndex((d) => d.day.slice(0, 10) === currentDay)
    : -1;
  // Lista vem do mais recente para o mais antigo.
  const hasNewer = currentIndex > 0;
  const hasOlder = currentIndex >= 0 && currentIndex < digests.length - 1;
  const goNewer = () => hasNewer && setSelectedDay(digests[currentIndex - 1].day.slice(0, 10));
  const goOlder = () => hasOlder && setSelectedDay(digests[currentIndex + 1].day.slice(0, 10));

  const todayStr = format(new Date(), 'yyyy-MM-dd');
  const hasToday = digests.some((d) => d.day.slice(0, 10) === todayStr);
  const generating = generateMutation.isPending;

  // Mantém o chip do dia ativo à vista quando a navegação vem das setas.
  useEffect(() => {
    activeChipRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [currentDay]);

  return (
    <AppLayout title="Seu dia, espremido.">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <p className="max-w-prose text-muted-foreground">O que pediu sua atenção, o que ficou combinado e o que ainda falta resolver nas conversas sincronizadas.</p>
        {/* Dias + gerar — uma linha, todos os viewports */}
        <div className="flex items-center gap-2">
          {digestsQuery.isLoading ? (
            <div className="flex flex-1 items-center gap-1.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-24 rounded-full" />
              ))}
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <ScrollRow fade="background">
                {digests.map((d) => {
                  const day = d.day.slice(0, 10);
                  const active = day === currentDay;
                  return (
                    <button
                      key={d.id}
                      type="button"
                      ref={active ? activeChipRef : undefined}
                      onClick={() => setSelectedDay(day)}
                      className={cn(
                        'inline-flex min-h-11 shrink-0 items-center rounded-xl border px-4 text-sm font-medium capitalize transition-colors',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      {dayChipLabel(day)}
                    </button>
                  );
                })}
              </ScrollRow>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => generateMutation.mutate()}
            disabled={generating}
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', generating && 'animate-spin')} />
            {generating ? 'Gerando…' : 'Gerar agora'}
          </Button>
        </div>

        {digestsQuery.isError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Erro ao carregar digests</AlertTitle>
            <AlertDescription>
              {digestsQuery.error instanceof Error
                ? digestsQuery.error.message
                : 'Não foi possível falar com o servidor.'}
            </AlertDescription>
          </Alert>
        )}

        {/* Geração em andamento */}
        {generating && (
          <Card className="border-primary/25 bg-primary/5">
            <CardContent className="flex items-center gap-3 p-4">
              <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Gerando o digest…</p>
                <p className="text-xs text-muted-foreground">
                  Lendo as conversas do dia e escrevendo o resumo — leva cerca de 40 segundos.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Hoje ainda não gerado */}
        {!generating && !digestsQuery.isLoading && !digestsQuery.isError && !hasToday && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <CalendarClock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Hoje ainda não tem digest</p>
                  <p className="text-xs text-muted-foreground">
                    O resumo completo sai às 00:05, com o dia fechado — ou gere agora um parcial.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => generateMutation.mutate()}
              >
                Gerar digest de hoje
              </Button>
            </CardContent>
          </Card>
        )}

        {digestsQuery.isLoading && (
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-4 w-72" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-5/6" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        )}

        {!digestsQuery.isLoading && !digestsQuery.isError && !current && !generating && (
          <Card>
            <CardContent className="space-y-3 py-12 text-center">
              <Newspaper className="mx-auto h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">
                Nenhum digest ainda. Ele roda sozinho às 00:05 — ou clique em "Gerar agora".
              </p>
            </CardContent>
          </Card>
        )}

        {current && (
          <Card>
            <CardHeader className="space-y-3 pb-4">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="min-w-0 truncate text-base">{dayTitle(current.day)}</CardTitle>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    title="Dia anterior"
                    disabled={!hasOlder}
                    onClick={goOlder}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    title="Próximo dia"
                    disabled={!hasNewer}
                    onClick={goNewer}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {current.stats && (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <MessageCircle className="h-3.5 w-3.5" />
                      <span className="font-medium tabular-nums text-foreground">
                        {current.stats.messages}
                      </span>
                      mensagens
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <MessagesSquare className="h-3.5 w-3.5" />
                      <span className="font-medium tabular-nums text-foreground">
                        {current.stats.chats}
                      </span>
                      conversas
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Mic className="h-3.5 w-3.5" />
                      <span className="font-medium tabular-nums text-foreground">
                        {current.stats.audios}
                      </span>
                      áudios
                    </span>
                  </>
                )}
                <span className="text-muted-foreground/70">
                  gerado às {format(new Date(current.created_at), 'HH:mm', { locale: ptBR })}
                </span>
              </div>

              {current.stats && current.stats.top_chats.length > 0 && (
                <ScrollRow>
                  <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground/70">
                    Mais ativas
                  </span>
                  {current.stats.top_chats.map((tc) => (
                    <span
                      key={tc.name}
                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2.5 text-xs text-muted-foreground"
                    >
                      <span className="max-w-[11rem] truncate">{tc.name}</span>
                      <span className="tabular-nums text-[10px] opacity-60">{tc.count}</span>
                    </span>
                  ))}
                </ScrollRow>
              )}
            </CardHeader>
            <CardContent className="pt-1">
              <SummaryMarkdown variant="digest" content={prepareDigestContent(current.content)} />
            </CardContent>
          </Card>
        )}
      </div>
    </AppLayout>
  );
};

export default Digest;
