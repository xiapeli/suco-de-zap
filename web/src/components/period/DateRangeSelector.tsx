
import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CalendarIcon } from 'lucide-react';
import { format, isValid, startOfDay, endOfDay, isBefore, isAfter } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface DateRangeSelectorProps {
  startDate?: Date;
  endDate?: Date;
  actualDateRange: { start: Date; end: Date };
  startDateOpen: boolean;
  endDateOpen: boolean;
  onStartDateChange: (date: Date | undefined) => void;
  onEndDateChange: (date: Date | undefined) => void;
  onStartDateOpenChange: (open: boolean) => void;
  onEndDateOpenChange: (open: boolean) => void;
  onSelectPreset: (hours: number) => void;
  onSelectFullPeriod: () => void;
}

const DateRangeSelector: React.FC<DateRangeSelectorProps> = ({
  startDate,
  endDate,
  actualDateRange,
  startDateOpen,
  endDateOpen,
  onStartDateChange,
  onEndDateChange,
  onStartDateOpenChange,
  onEndDateOpenChange,
  onSelectPreset,
  onSelectFullPeriod
}) => {
  // HANDLER PARA SELEÇÃO DE DATA INICIAL
  // Inclui validação automática para garantir consistência
  const handleStartDateSelect = (date: Date | undefined) => {
    console.log('DateRangeSelector: Start date selected:', date);
    
    if (date && isValid(date)) {
      onStartDateChange(date);
      onStartDateOpenChange(false);
      
      // AUTO-CORREÇÃO: Se a data final é anterior à inicial, ajustar automaticamente
      if (endDate && isAfter(date, endDate)) {
        console.log('DateRangeSelector: Auto-correcting end date (was before start date)');
        onEndDateChange(date);
      }
    } else {
      console.warn('DateRangeSelector: Invalid start date selected:', date);
    }
  };

  // HANDLER PARA SELEÇÃO DE DATA FINAL
  // Inclui validação automática para garantir consistência
  const handleEndDateSelect = (date: Date | undefined) => {
    console.log('DateRangeSelector: End date selected:', date);
    
    if (date && isValid(date)) {
      onEndDateChange(date);
      onEndDateOpenChange(false);
      
      // AUTO-CORREÇÃO: Se a data inicial é posterior à final, ajustar automaticamente
      if (startDate && isBefore(date, startDate)) {
        console.log('DateRangeSelector: Auto-correcting start date (was after end date)');
        onStartDateChange(date);
      }
    } else {
      console.warn('DateRangeSelector: Invalid end date selected:', date);
    }
  };

  // FUNÇÃO CRÍTICA: Determinar se uma data deve estar desabilitada no calendário
  // IMPORTANTE: Usar apenas o período real do chat, não permitir datas fora do range
  const isDateDisabled = (date: Date) => {
    if (!actualDateRange || !isValid(date)) {
      console.log('DateRangeSelector: Date disabled - no actual range or invalid date');
      return true;
    }
    
    // VALIDAÇÃO SIMPLIFICADA: Usar apenas comparação de data (ignorar horário)
    // Isso evita problemas de timezone no componente de calendário
    const dateOnly = startOfDay(date);
    const rangeStart = startOfDay(actualDateRange.start);
    const rangeEnd = startOfDay(actualDateRange.end);
    
    const disabled = isBefore(dateOnly, rangeStart) || isAfter(dateOnly, rangeEnd);
    
    if (disabled) {
      console.log('DateRangeSelector: Date disabled - outside actual chat range:', {
        date: format(date, 'yyyy-MM-dd'),
        actualStart: format(actualDateRange.start, 'yyyy-MM-dd'),
        actualEnd: format(actualDateRange.end, 'yyyy-MM-dd'),
        reason: isBefore(dateOnly, rangeStart) ? 'before range' : 'after range'
      });
    }
    
    return disabled;
  };

  // CONTROLE DE POPOVERS: Garantir que apenas um calendário esteja aberto por vez
  const handleStartDateOpenChange = (open: boolean) => {
    console.log('DateRangeSelector: Start date popover open change:', open);
    onStartDateOpenChange(open);
    
    // Fechar popover de data final se estamos abrindo o de data inicial
    if (open && endDateOpen) {
      console.log('DateRangeSelector: Closing end date popover (start opening)');
      onEndDateOpenChange(false);
    }
  };

  const handleEndDateOpenChange = (open: boolean) => {
    console.log('DateRangeSelector: End date popover open change:', open);
    onEndDateOpenChange(open);
    
    // Fechar popover de data inicial se estamos abrindo o de data final
    if (open && startDateOpen) {
      console.log('DateRangeSelector: Closing start date popover (end opening)');
      onStartDateOpenChange(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center space-x-2">
          <CalendarIcon className="h-5 w-5" />
          <span>Selecionar Período</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* INFORMAÇÕES DO PERÍODO REAL DISPONÍVEL NO CHAT */}
        {/* IMPORTANTE: Sempre mostrar o período real, não o que foi detectado no upload */}
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-sm font-medium mb-1">Período real disponível no chat:</p>
          <p className="text-xs text-muted-foreground">
            {format(actualDateRange.start, 'dd/MM/yyyy', { locale: ptBR })} até {' '}
            {format(actualDateRange.end, 'dd/MM/yyyy', { locale: ptBR })}
          </p>
          <p className="text-xs text-muted-foreground mt-1 opacity-75">
            (Calculado a partir das mensagens reais no banco de dados)
          </p>
        </div>

        {/* PERÍODOS RÁPIDOS BASEADOS NO CHAT REAL */}
        {/* NOTA: Os presets calculam a partir do fim real do chat, não da data atual */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Períodos Rápidos:</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.log('DateRangeSelector: Preset 24h selected (from actual chat end)');
                onSelectPreset(24);
              }}
            >
              Últimas 24 horas
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.log('DateRangeSelector: Preset 7 days selected (from actual chat end)');
                onSelectPreset(7 * 24);
              }}
            >
              Últimos 7 dias
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.log('DateRangeSelector: Preset 30 days selected (from actual chat end)');
                onSelectPreset(30 * 24);
              }}
            >
              Últimos 30 dias
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                console.log('DateRangeSelector: Full period selected (entire actual chat range)');
                onSelectFullPeriod();
              }}
            >
              Período Completo
            </Button>
          </div>
        </div>

        {/* SELEÇÃO PERSONALIZADA DE DATAS */}
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Período Personalizado:</label>
            <div className="grid grid-cols-2 gap-4">
              {/* SELETOR DE DATA INICIAL */}
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Data Início:</label>
                <Popover open={startDateOpen} onOpenChange={handleStartDateOpenChange}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !startDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {startDate && isValid(startDate) 
                        ? format(startDate, "dd/MM/yyyy", { locale: ptBR }) 
                        : "Selecionar"
                      }
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={handleStartDateSelect}
                      disabled={isDateDisabled}
                      initialFocus
                      className="pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>
              
              {/* SELETOR DE DATA FINAL */}
              <div className="space-y-2">
                <label className="text-xs text-muted-foreground">Data Fim:</label>
                <Popover open={endDateOpen} onOpenChange={handleEndDateOpenChange}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !endDate && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {endDate && isValid(endDate) 
                        ? format(endDate, "dd/MM/yyyy", { locale: ptBR }) 
                        : "Selecionar"
                      }
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={endDate}
                      onSelect={handleEndDateSelect}
                      disabled={isDateDisabled}
                      initialFocus
                      className="pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        </div>

        {/* VISUALIZAÇÃO DO PERÍODO ATUALMENTE SELECIONADO */}
        {startDate && endDate && (
          <div className="bg-primary/10 rounded-lg p-3">
            <p className="text-sm font-medium text-primary">Período selecionado:</p>
            <p className="text-xs text-muted-foreground">
              {format(startDate, 'dd/MM/yyyy', { locale: ptBR })} até {' '}
              {format(endDate, 'dd/MM/yyyy', { locale: ptBR })}
            </p>
            <p className="text-xs text-muted-foreground mt-1 opacity-75">
              ({Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))} dias)
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default DateRangeSelector;
