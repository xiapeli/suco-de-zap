import {AppLayout} from '@/components/AppLayout';
import {CalendarRuntime} from '@/components/calendar/CalendarRuntime';
export default function Calendar(){return <AppLayout breadcrumbs={[{label:'Início',href:'/'},{label:'Agenda'}]}><CalendarRuntime/></AppLayout>;}
