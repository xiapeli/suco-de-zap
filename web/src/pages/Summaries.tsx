import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, Summary } from '@/lib/api';
import { AppLayout } from '@/components/AppLayout';
import SummaryMarkdown from '@/components/SummaryMarkdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { analysisTypes } from '@/components/analysis/AnalysisTypeSelector';
import { CupSoda, Trash2, Eye, AlertTriangle, Bot } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const ALL_CHATS = '__all__';

const analysisTypeLabel = (id: string) =>
  analysisTypes.find((type) => type.id === id)?.title ?? (id.startsWith('personal:') ? 'Tipo personalizado' : id);

const Summaries = () => {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [chatFilter, setChatFilter] = useState<string>(ALL_CHATS);
  const [viewing, setViewing] = useState<Summary | null>(null);
  const [deleting, setDeleting] = useState<Summary | null>(null);

  const summariesQuery = useQuery({
    queryKey: ['summaries', chatFilter],
    queryFn: () =>
      api.summaries({
        chat_jid: chatFilter === ALL_CHATS ? undefined : chatFilter,
        limit: 100,
      }),
  });

  // Opções do filtro: conversas que aparecem nos sucos já carregados + lista de chats
  const chatsQuery = useQuery({
    queryKey: ['chats', ''],
    queryFn: () => api.chats({ limit: 200 }),
  });

  const filterOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const summary of summariesQuery.data?.summaries ?? []) {
      map.set(summary.chat_jid, summary.chat_name);
    }
    for (const chat of chatsQuery.data?.chats ?? []) {
      if (!map.has(chat.jid)) map.set(chat.jid, chat.name);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [summariesQuery.data, chatsQuery.data]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteSummary(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summaries'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast({ title: 'Suco excluído', description: 'O resumo foi removido do histórico.' });
      setDeleting(null);
      setViewing(null);
    },
    onError: (error) => {
      toast({
        title: 'Erro ao excluir suco',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
      setDeleting(null);
    },
  });

  const summaries = summariesQuery.data?.summaries ?? [];

  return (
    <AppLayout title="Sucos">
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            O que ficou combinado merece ficar fácil de achar. Seus sucos manuais e automáticos estão aqui.
          </p>
          <Select value={chatFilter} onValueChange={setChatFilter}>
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="Filtrar por conversa" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CHATS}>Todas as conversas</SelectItem>
              {filterOptions.map(([jid, name]) => (
                <SelectItem key={jid} value={jid}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {summariesQuery.isError && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Erro ao carregar sucos</AlertTitle>
            <AlertDescription>
              {summariesQuery.error instanceof Error
                ? summariesQuery.error.message
                : 'Não foi possível falar com o servidor.'}
            </AlertDescription>
          </Alert>
        )}

        {summariesQuery.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        )}

        {!summariesQuery.isLoading && !summariesQuery.isError && summaries.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center space-y-3">
              <CupSoda className="h-10 w-10 text-muted-foreground mx-auto" />
              <p className="text-muted-foreground">
                {chatFilter === ALL_CHATS
                  ? 'Nenhum suco gerado ainda.'
                  : 'Nenhum suco para essa conversa.'}
              </p>
              <Button asChild variant="outline">
                <Link to="/conversations">Gerar meu primeiro suco</Link>
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="suco-summary-list">
          {summaries.map((summary) => (
            <Card
              key={summary.id}
              className="suco-summary-row cursor-pointer"
              onClick={() => setViewing(summary)}
            >
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium truncate">
                        {summary.title || `Suco de ${summary.chat_name}`}
                      </p>
                      {summary.auto && (
                        <Badge variant="secondary" className="text-xs">
                          <Bot className="h-3 w-3 mr-1" />
                          Automático
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {summary.chat_name} · {analysisTypeLabel(summary.analysis_type)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Período:{' '}
                      {format(new Date(summary.period_start), 'dd/MM/yyyy', { locale: ptBR })} –{' '}
                      {format(new Date(summary.period_end), 'dd/MM/yyyy', { locale: ptBR })} · gerado
                      em{' '}
                      {format(new Date(summary.created_at), "dd/MM/yyyy 'às' HH:mm", {
                        locale: ptBR,
                      })}
                    </p>
                  </div>
                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button variant="ghost" size="icon" aria-label={`Abrir ${summary.title || `suco de ${summary.chat_name}`}`} onClick={() => setViewing(summary)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                    <Button
                      aria-label={`Excluir ${summary.title || `suco de ${summary.chat_name}`}`}
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleting(summary)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Visualização do suco */}
      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent className="max-w-3xl">
          {viewing && (
            <>
              <DialogHeader>
                <DialogTitle>{viewing.title || `Suco de ${viewing.chat_name}`}</DialogTitle>
                <DialogDescription>
                  {viewing.chat_name} · {analysisTypeLabel(viewing.analysis_type)} ·{' '}
                  {format(new Date(viewing.period_start), 'dd/MM/yyyy', { locale: ptBR })} –{' '}
                  {format(new Date(viewing.period_end), 'dd/MM/yyyy', { locale: ptBR })} · modelo{' '}
                  {viewing.model}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[65vh] pr-4">
                <SummaryMarkdown content={viewing.content} />
                <Button asChild variant="outline" className="mt-6"><Link to={`/calendar?summary=${viewing.id}`}>Preparar convite</Link></Button>
              </ScrollArea>
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  className="text-destructive"
                  onClick={() => setDeleting(viewing)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Excluir suco
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmação de exclusão */}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir este suco?</AlertDialogTitle>
            <AlertDialogDescription>
              O resumo "{deleting?.title || deleting?.chat_name}" será removido permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
            >
              {deleteMutation.isPending ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default Summaries;
