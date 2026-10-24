import { ArrowRight, BookOpen, GlassWater, MessageCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

const areas = [
  { name: 'Fazer um suco', path: '/', description: 'Escolha um dos 17 temas ou escreva o que quer entender. Depois selecione conversa e período antes de gerar.' },
  { name: 'Conversas', path: '/conversations', description: 'Veja os grupos e as mensagens salvas. Sincronize ou reconecte o WhatsApp se uma conversa parar de atualizar.' },
  { name: 'Meus tipos', path: '/my-juices', description: 'Crie uma receita própria, guarde as instruções e use o mesmo tipo em outras conversas.' },
  { name: 'Meus sucos', path: '/summaries', description: 'Leia os resultados salvos. Confira decisões, datas e valores na conversa original.' },
  { name: 'Resumo do dia', path: '/digest', description: 'Reúna mensagens de um dia para ver assuntos, decisões e pendências em várias conversas.' },
  { name: 'Cofre', path: '/cofre', description: 'Busque trechos nas mensagens salvas, inclusive Pix, e-mails, telefones e endereços.' },
  { name: 'Agenda', path: '/calendar', description: 'Use um suco como referência para montar um evento, abrir um rascunho no Google Agenda ou baixar um arquivo .ics.' },
  { name: 'Configurações', path: '/settings', description: 'Confira o estado da conexão e as opções de atualização da sua conta.' },
];

export function PrivateGuide({ onNavigate }: { onNavigate: (path: string) => void }) {
  return <article className="private-guide">
    <div className="private-juice-card"><p className="private-eyebrow"><BookOpen size={15} /> Guia do Suco</p>
      <h2>Cada coisa no seu lugar.</h2><p>As mensagens chegam em Conversas. Os sucos e o Resumo do dia ajudam a entender o que aconteceu. O Cofre ajuda a reencontrar um dado citado no WhatsApp.</p>
      <div className="private-guide-start"><Button onClick={() => onNavigate('/')}><GlassWater size={16} /> Fazer um suco</Button>
        <Button variant="outline" onClick={() => onNavigate('/conversations')}><MessageCircle size={16} /> Ver conversas</Button></div>
    </div>
    <div className="private-guide-list">{areas.map(area => <section key={area.path} className="private-juice-card">
      <div><h2>{area.name}</h2><Button variant="ghost" onClick={() => onNavigate(area.path)}>Abrir <ArrowRight size={16} /></Button></div>
      <p>{area.description}</p>
    </section>)}</div>
    <section className="private-juice-card"><p className="private-eyebrow"><ShieldCheck size={15} /> Privacidade e limites</p>
      <h2>O que entra na análise</h2><p>O Suco lê apenas as mensagens já sincronizadas. Para gerar um suco ou resumo do dia, você autoriza o envio do recorte escolhido ao provedor de IA. Áudios não são transcritos nesta versão. O WhatsApp pode não reenviar todo o histórico antigo após uma reconexão.</p>
    </section>
  </article>;
}
