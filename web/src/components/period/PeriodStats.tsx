
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MessageSquare, Users, Clock, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface ProcessResult {
  chatName: string;
  messageCount: number;
  participantsCount: number;
  isGroupChat: boolean;
}

interface PeriodStatsProps {
  uploadData: ProcessResult;
  actualDateRange: { start: Date; end: Date };
  startDate?: Date;
  endDate?: Date;
  filteredMessageCount: number;
  loading: boolean;
}

const PeriodStats: React.FC<PeriodStatsProps> = ({
  uploadData,
  actualDateRange,
  startDate,
  endDate,
  filteredMessageCount,
  loading
}) => {
  return (
    <>
      {/* Header Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Informações do Chat</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex items-center space-x-2">
              <MessageSquare className="h-5 w-5 text-primary" />
              <div>
                <p className="font-semibold">{uploadData.chatName}</p>
                <p className="text-sm text-muted-foreground">{uploadData.messageCount} mensagens totais</p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Users className="h-5 w-5 text-primary" />
              <div>
                <p className="font-semibold">{uploadData.participantsCount} participantes</p>
                <p className="text-sm text-muted-foreground">
                  {uploadData.isGroupChat ? 'Conversa em grupo' : 'Conversa individual'}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <Clock className="h-5 w-5 text-primary" />
              <div>
                <p className="font-semibold">Período Total</p>
                <p className="text-sm text-muted-foreground">
                  {format(actualDateRange.start, 'dd/MM/yyyy', { locale: ptBR })} - {' '}
                  {format(actualDateRange.end, 'dd/MM/yyyy', { locale: ptBR })}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Preview Stats */}
      <Card>
        <CardHeader>
          <CardTitle>Preview do Período Selecionado</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
              <p className="mt-2 text-sm text-muted-foreground">Carregando preview...</p>
            </div>
          ) : (
            <>
              {/* Stats */}
              <div className="bg-muted rounded-lg p-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-2xl font-bold text-primary">{filteredMessageCount}</p>
                    <p className="text-sm text-muted-foreground">mensagens no período</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-primary">
                      {Math.round((filteredMessageCount / uploadData.messageCount) * 100)}%
                    </p>
                    <p className="text-sm text-muted-foreground">do total</p>
                  </div>
                </div>
              </div>

              {/* Date Range */}
              {startDate && endDate && (
                <div className="text-center p-4 bg-muted rounded-lg">
                  <div className="flex items-center justify-center space-x-2 text-sm text-muted-foreground">
                    <span>{format(startDate, 'dd/MM/yyyy', { locale: ptBR })}</span>
                    <ArrowRight className="h-4 w-4" />
                    <span>{format(endDate, 'dd/MM/yyyy', { locale: ptBR })}</span>
                  </div>
                </div>
              )}

              {filteredMessageCount === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  <p>Nenhuma mensagem encontrada no período selecionado</p>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
};

export default PeriodStats;
