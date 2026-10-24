import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Download, ExternalLink } from 'lucide-react';
import { confidentialApi, confidentialErrorText } from '@/lib/confidential-api';
import type { ConfidentialChannel } from '@/lib/confidential-channel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function calendarStamp(date: Date): string { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function icsText(value: string): string { return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }

export function PrivateCalendar({ channel, accountId }: { channel: ConfidentialChannel; accountId: string }) {
  const summaries = useQuery({ queryKey: ['private', accountId, 'summaries', 0],
    queryFn: () => confidentialApi.summaries(channel, 50, 0), refetchOnWindowFocus: true });
  const [sourceId, setSourceId] = useState('');
  const [title, setTitle] = useState('');
  const [day, setDay] = useState('');
  const [time, setTime] = useState('09:00');
  const [duration, setDuration] = useState(60);
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const source = summaries.data?.summaries.find(item => item.id === sourceId);

  function event(): { start: Date; end: Date } | null {
    const start = new Date(`${day}T${time}:00`);
    if (!title.trim() || !day || !time || !Number.isFinite(start.valueOf()) ||
        duration < 15 || duration > 240) { setError('Informe título, data, hora e duração válidos.'); return null; }
    setError('');
    return { start, end: new Date(start.valueOf() + duration * 60_000) };
  }

  function openGoogle() {
    const dates = event(); if (!dates) return;
    const url = new URL('https://calendar.google.com/calendar/render');
    url.searchParams.set('action', 'TEMPLATE');
    url.searchParams.set('text', title.trim());
    url.searchParams.set('dates', `${calendarStamp(dates.start)}/${calendarStamp(dates.end)}`);
    if (description.trim()) url.searchParams.set('details', description.trim());
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }

  function downloadIcs() {
    const dates = event(); if (!dates) return;
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Suco de Zap//Agenda//PT-BR',
      'BEGIN:VEVENT', `UID:${crypto.randomUUID()}@sucodezap.xyz`,
      `DTSTAMP:${calendarStamp(new Date())}`, `DTSTART:${calendarStamp(dates.start)}`,
      `DTEND:${calendarStamp(dates.end)}`, `SUMMARY:${icsText(title.trim())}`,
      ...(description.trim() ? [`DESCRIPTION:${icsText(description.trim())}`] : []),
      'END:VEVENT', 'END:VCALENDAR', ''];
    const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'suco-agenda.ics';
    anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  return <div className="private-juice-flow"><section className="private-juice-card">
    <h2>Leve um combinado para a agenda.</h2><p className="private-juice-hint">Monte o evento, confira os dados e abra um rascunho no Google Agenda ou baixe o arquivo para importar.</p>
    {summaries.error && <p className="private-error" role="alert">{confidentialErrorText(summaries.error)}</p>}
    <label className="private-juice-field">Suco de referência (opcional)<select value={sourceId} onChange={event => setSourceId(event.target.value)}>
      <option value="">Sem referência</option>{summaries.data?.summaries.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
    </select></label>
    {source && <div className="private-calendar-source"><strong>{source.chat_name}</strong><p>{source.content.slice(0, 500)}{source.content.length > 500 ? '…' : ''}</p>
      <Button variant="ghost" size="sm" onClick={() => setTitle(source.title.slice(0, 180))}>Usar título do suco</Button></div>}
    <div className="private-calendar-fields"><label>Título<Input required maxLength={180} value={title} onChange={event => setTitle(event.target.value)} placeholder="Ex.: reunião de alinhamento" /></label>
      <label>Data<Input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
      <label>Hora<Input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <label>Duração<select value={duration} onChange={event => setDuration(Number(event.target.value))}>
        {[30, 45, 60, 90, 120].map(minutes => <option key={minutes} value={minutes}>{minutes} minutos</option>)}
      </select></label></div>
    <label className="private-juice-field">Descrição (opcional)<textarea rows={4} maxLength={2000} value={description}
      onChange={event => setDescription(event.target.value)} placeholder="Inclua só o que você quer levar para a agenda." /></label>
    {error && <p className="private-error" role="alert">{error}</p>}
    <div className="private-calendar-actions"><Button onClick={openGoogle}><CalendarDays size={17} /> Abrir rascunho no Google Agenda <ExternalLink size={15} /></Button>
      <Button variant="outline" onClick={downloadIcs}><Download size={16} /> Baixar .ics</Button></div>
    <p className="private-juice-note">O evento só será criado depois que você confirmar no Google Agenda ou importar o arquivo. Título e descrição são enviados ao Google apenas ao abrir o rascunho.</p>
  </section></div>;
}
