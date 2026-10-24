import {useMemo} from 'react';
import {useConvex} from 'convex/react';
import {anyApi} from 'convex/server';
import {useCloudEnabled} from '@/components/CloudProvider';
import {CalendarWorkspace} from './CalendarWorkspace';
import type {CalendarClient} from '@/lib/calendar';
import {Link} from 'react-router-dom';
export function CalendarRuntime(){return useCloudEnabled()?<NativeCalendar/>:<p>Entre com sua conta do Suco para conectar o Google Agenda. <Link className="underline" to="/account">Abrir minha conta</Link></p>;}
function NativeCalendar(){const convex=useConvex();const client=useMemo<CalendarClient>(()=>({
 status:()=>convex.query(anyApi.calendar.status,{}),list:()=>convex.query(anyApi.calendar.list,{}),get:id=>convex.query(anyApi.calendar.get,{id}),
 prepare:sourceTicket=>convex.action(anyApi.calendarActions.prepare,{sourceTicket}),save:(id,revision,payload)=>convex.mutation(anyApi.calendar.save,{id,revision,payload}),confirm:(id,revision,fingerprint)=>convex.mutation(anyApi.calendar.confirm,{id,revision,fingerprint}),
 connect:async(id)=>{const result=await convex.action(anyApi.calendarActions.connect,id?{actionId:id}:{});const u=new URL(result.url);const expected=(import.meta.env.VITE_CONVEX_URL as string).replace('.convex.cloud','.convex.site');if(u.origin!==expected||u.pathname!=='/integrations/google/start')throw Error('CALENDAR_NOT_CONFIGURED');return result;},
 disconnect:()=>convex.mutation(anyApi.calendar.disconnect,{}),checkAgain:id=>convex.mutation(anyApi.calendar.checkAgain,{id}),dismiss:id=>convex.mutation(anyApi.calendar.dismiss,{id})
 }),[convex]);return <CalendarWorkspace client={client}/>;}
