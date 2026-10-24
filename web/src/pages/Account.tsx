import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthActions } from '@convex-dev/auth/react';
import { useConvexAuth, useAction, useMutation, useQuery } from 'convex/react';
import { anyApi } from 'convex/server';
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { useCloudEnabled } from '@/components/CloudProvider';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { api, MANAGED_SESSION_KEY } from '@/lib/api';
import { AccountAuthForm } from '@/components/account/AccountAuthForm';
import { AccountSessionBoundary } from '@/components/account/AccountSessionBoundary';
import { ActivationSteps } from '@/components/onboarding/ActivationSteps';

function AccountAuth() {
  const { signIn } = useAuthActions();
  return <AccountAuthForm signIn={signIn}/>;
}

export interface AccountAccessState {
  owner: boolean; paid: boolean; access: 'owner' | 'paid' | 'trial' | 'trial_exhausted';
  setupStatus: string; capacityAvailable: boolean; firstSummaryAt?: number;
  trial: { limit: number; completed: number; reserved: number; remaining: number };
}
// Keep the existing owner account and history intact while the private
// Supabase runtime is prepared. The stopped worker cannot serve a live QR.
// This build-time switch is enabled only after an explicit owner-only privacy
// exception and a verified live worker. Production defaults to the safe hold.
const OWNER_PRIVATE_MIGRATION_HOLD = import.meta.env.VITE_SUCO_LEGACY_OWNER_ALLOWED !== 'true';
export function AccountAccessPanel({ account, pending, onConnect, onPrepare, onShowPlans }: { account: AccountAccessState; pending: boolean; onConnect: (destination: string) => void; onPrepare: () => void; onShowPlans: () => void }) {
  if (!['owner','paid','trial','trial_exhausted'].includes(account.access) || (account.access === 'owner' && !account.owner) || (account.access === 'paid' && !account.paid)) return <section className="account-section" role="status"><h2>Conferindo seu acesso.</h2><p>Aguarde a confirmação da sua conta antes de conectar. Nenhuma cobrança é iniciada nesta etapa.</p></section>;
  const owner = account.owner && account.access === 'owner';
  if (owner && OWNER_PRIVATE_MIGRATION_HOLD) return <section className="account-section" role="status"><ShieldCheck className="text-primary" />
    <h2>Sua conta continua a mesma.</h2>
    <p>Sua conexão com o WhatsApp está pausada durante a migração para o Supabase. O histórico existente foi preservado e ainda não foi importado.</p>
    <p className="text-sm">O QR de reconexão ainda não está disponível. Ele será liberado nesta conta após a verificação do processamento privado; aí você poderá atualizar a página e ler o código no seu telefone.</p>
  </section>;
  const trial = account.access === 'trial' || account.access === 'trial_exhausted';
  const exhausted = account.access === 'trial_exhausted';
  const ready = account.setupStatus === 'ready';
  const inPreparation = ['queued', 'leased', 'blocked'].includes(account.setupStatus);
  return <section className="account-section" aria-label="Acesso ao seu espaço"><CheckCircle2 className="text-primary" />
    <h2>{owner ? 'Seu espaço, sem etapa de pagamento.' : trial ? exhausted ? 'Seus sucos grátis foram concluídos.' : 'Comece com seus sucos grátis.' : 'Assinatura confirmada.'}</h2>
    <p>{owner ? 'Seu acesso de parceiro é completo e ilimitado, sem cobrança. Você pode conectar o WhatsApp sem contratar uma assinatura.' : trial ? `${account.trial.completed} de ${account.trial.limit} sucos grátis concluídos · ${account.trial.remaining} disponíveis.` : 'Sua assinatura foi confirmada. Continue para o seu espaço.'}</p>
    {trial && <p className="text-sm">{exhausted ? 'Os resumos já salvos continuam disponíveis. Novas sincronizações e análises ficam pausadas até a assinatura.' : 'São resumos manuais, sem cartão. Apenas resumos concluídos usam sua cota; os 3 sucos são por conta e não renovam todo mês. Automação, digest e busca no Cofre fazem parte da assinatura.'}</p>}
    {trial && account.trial.reserved > 0 && <p className="text-sm" role="status">{account.trial.reserved} pedido(s) em processamento ou confirmação. Não é necessário iniciar outro pedido.</p>}
    <p className="text-sm" role="status">{ready ? exhausted ? 'Seu espaço continua disponível para ler os sucos salvos. A sincronização permanece pausada.' : 'Seu espaço está pronto. Na próxima tela você verá se o WhatsApp está conectado ou se precisa ler um QR para conectar de novo.' : account.setupStatus === 'queued' ? 'Sua solicitação está na fila de preparação; o espaço ainda não está ativo.' : account.setupStatus === 'leased' ? 'Seu espaço está sendo preparado. Aguarde esta etapa terminar.' : account.setupStatus === 'blocked' ? 'A preparação precisa de atenção da equipe. Sua conta e seus dados foram preservados.' : account.capacityAvailable ? 'Prepare seu espaço para continuar até a conexão pelo QR.' : 'A ativação de novos espaços está temporariamente indisponível. Sua conta está salva; nenhum espaço foi criado nesta etapa.'}</p>
    <Button className="mt-6" disabled={pending || (!ready && (inPreparation || !account.capacityAvailable))} onClick={() => ready ? onConnect(exhausted ? '/summaries' : account.firstSummaryAt ? '/' : '/onboarding') : onPrepare()}>{pending ? 'Conferindo…' : ready ? exhausted ? 'Ler meus sucos salvos' : account.firstSummaryAt ? 'Abrir meu espaço' : 'Continuar para a conexão' : !account.capacityAvailable ? 'Aguardando disponibilidade' : 'Preparar meu espaço'}<ArrowRight className="ml-2 h-4 w-4" /></Button>
    {trial && !exhausted && <Button variant="ghost" className="mt-4" disabled={pending} onClick={onShowPlans}>Conhecer a assinatura</Button>}
  </section>;
}

export interface AccountOffer { id?: string; plan?: string; proposedBrl: number; enabled: boolean }
export function AccountOfferCards({ account, offers, pending, onCheckout }: {account: Pick<AccountAccessState, 'setupStatus' | 'capacityAvailable'>; offers: AccountOffer[]; pending: boolean; onCheckout: (plan: string) => void}) {
  const spaceReady = account.setupStatus === 'ready';
  return <div className="account-plans">{offers.map(offer => <article key={offer.plan || offer.id}><h3>{offer.plan === 'pro' || offer.id === 'pro' ? 'Pro' : 'Essencial'}</h3><p className="account-price">R$ {offer.proposedBrl.toLocaleString('pt-BR')}<span>/mês</span></p><Button disabled={!offer.enabled || pending || !spaceReady} onClick={() => onCheckout(offer.plan || offer.id)}>{!spaceReady ? account.capacityAvailable ? 'Prepare seu espaço para assinar' : 'Novas ativações indisponíveis' : offer.enabled ? 'Conferir assinatura' : 'Assinatura indisponível no momento'}</Button></article>)}</div>;
}

function AccountHome() {
  const { signOut } = useAuthActions();
  const { logout, login } = useAuth();
  const navigate = useNavigate();
  const ensure = useMutation(anyApi.accounts.ensure);
  const preferences = useMutation(anyApi.accounts.preferences);
  const checkout = useAction(anyApi.billing.checkout);
  const portal = useAction(anyApi.billing.portal);
  const tenantAccess = useAction(anyApi.accounts.tenantAccess);
  const requestProvision = useMutation(anyApi.accounts.requestProvision);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const account = useQuery(anyApi.accounts.me, ready ? {} : 'skip');
  const catalog = useQuery(anyApi.accounts.catalog, {});
  useEffect(() => { let mounted = true; ensure({}).then(() => { if(mounted) setReady(true); }).catch(() => { if(mounted) setError('Não conseguimos confirmar sua sessão. Saia da conta e entre novamente para retomar seu espaço.'); }); return () => { mounted = false; }; }, [ensure]);
  async function saveConsent() { setPending(true); setError(''); try { await preferences({ consentVersion:'readonly-2026-10-15', timezone:'America/Sao_Paulo', summaryHour:8 }); } catch { setError('Não conseguimos salvar sua autorização. Tente novamente.'); } finally { setPending(false); } }
  async function connectSpace(destination = '/onboarding') { setPending(true); setError(''); try { const access = await tenantAccess({scope:'read'}); const result = await login(access.accessToken,access.apiUrl); if(result.error) throw new Error(result.error); if (account?.consentVersion !== 'readonly-2026-10-15') throw new Error('CONSENT_REQUIRED'); await api.consent(); localStorage.setItem(MANAGED_SESSION_KEY,JSON.stringify({tenantId:access.tenantId,expiresAt:access.expiresAt})); navigate(destination); } catch { setError('Seu espaço ainda não pôde ser conectado. Confira o estado da preparação e tente novamente.'); } finally { setPending(false); } }
  async function prepareSpace() { if (!account?.capacityAvailable) return; setPending(true); setError(''); try { await requestProvision({}); } catch { setError('Não conseguimos iniciar a preparação. Tente novamente.'); } finally { setPending(false); } }
  async function openPayment(plan: string) { setPending(true); setError(''); try { const res = await checkout({plan}); const u = new URL(res.url); if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== 'checkout.stripe.com') throw new Error(); window.location.assign(res.url); } catch { setError('A assinatura não pôde ser aberta agora. Nenhuma confirmação de pagamento foi registrada nesta tela.'); } finally { setPending(false); } }
  async function openPortal() { setPending(true); setError(''); try { const res = await portal({}); const u = new URL(res.url); if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hostname !== 'billing.stripe.com') throw new Error(); window.location.assign(res.url); } catch { setError('Não conseguimos abrir a gestão da assinatura. Tente novamente.'); } finally { setPending(false); } }
  return <div className="account-home"><div className="flex justify-between items-center gap-4"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="Suco de Zap" width="64" height="64" /><Button variant="ghost" onClick={async()=>{ logout(); await signOut(); }}>Sair da conta</Button></div><ActivationSteps current={account?.firstSummaryAt?3:1}/><h1>{account?.firstSummaryAt?'Seu espaço no Suco.':'Vamos ao seu primeiro suco.'}</h1><p className="account-intro">Conta criada. Agora você escolhe como o Suco pode ajudar no seu dia.</p>
    {!account && !error && <p role="status" className="flow-loading"><Loader2 size={20} className="animate-spin" />Abrindo seu espaço…</p>}
    {account && !account.consentVersion && <section className="account-section"><ShieldCheck className="text-primary" /><h2>Você decide antes de conectar.</h2><p>O Suco acessa seu WhatsApp como um aparelho conectado, apenas para leitura. As conversas disponibilizadas serão sincronizadas e processadas para busca e resumos. Escolher conversas para resumos não limita a sincronização inicial. Não há envio de mensagens ou transcrição de áudios nesta versão.</p><p>Os recortes para análise são enviados à IA em nuvem da Zhipu/BigModel. As credenciais de conexão do WhatsApp não são enviadas nessa análise. A conexão usa uma biblioteca não oficial e pode exigir novo QR. Uma restrição na conta do WhatsApp pode impedir a conexão.</p><label className="consent-control mt-6"><Checkbox checked={consent} onCheckedChange={v=>setConsent(v===true)} /><span>Entendi e autorizo a sincronização e o processamento das conversas da minha conta para essas funções.</span></label><Button className="mt-6" disabled={!consent||pending} onClick={saveConsent}>Salvar minha autorização<ArrowRight className="ml-2 h-4 w-4" /></Button></section>}
    {account?.consentVersion && <AccountAccessPanel account={account} pending={pending} onConnect={(destination) => connectSpace(destination)} onPrepare={prepareSpace} onShowPlans={() => setShowPlans(value => !value)} />}
    {account?.consentVersion && !account.owner && !account.paid && (showPlans || account.access === 'trial_exhausted') && <section className="account-section"><h2>Continue com a assinatura.</h2><p>Seus resumos salvos continuam disponíveis. Confira o preço e as condições antes de preparar mais sucos.</p>{account.billingStatus !== 'none' && <p className="billing-state" role="status">Sua assinatura precisa de atenção. Confira a situação na gestão de pagamento.</p>}<AccountOfferCards account={account} offers={Array.isArray(catalog) ? catalog : catalog?.offers || []} pending={pending} onCheckout={openPayment} /><p className="text-sm text-muted-foreground">Seus 3 sucos grátis não exigem cartão. A assinatura só começa quando você confirmar a contratação.</p></section>}
    {account && !account.owner && account.billingStatus && account.billingStatus !== 'none' && <Button variant="outline" className="mt-6" disabled={pending} onClick={openPortal}>Gerenciar pagamento e cancelamento</Button>}
    {error && <div className="flow-error" role="alert">{error}</div>}
  </div>;
}
function NativeAccount() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const {signOut}=useAuthActions();const {logout}=useAuth();
  const recover=()=>{logout();void signOut().catch(()=>{});};
  return isLoading ? <p className="p-8" role="status">Conferindo sua conta…</p> : isAuthenticated ? <AccountSessionBoundary onRecover={recover}><AccountHome /></AccountSessionBoundary> : <AccountAuth />;
}
export default function Account() {
  const enabled = useCloudEnabled();
  return <main className="account-page">{enabled ? <NativeAccount /> : <div className="account-auth"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="Suco de Zap" width="72" height="72" /><h1>Estamos preparando seu novo espaço.</h1><p>O cadastro público e a assinatura ainda estão em preparação. Se você já recebeu sua ativação assistida, pode entrar com seu código.</p><Button asChild className="mt-6"><Link to="/auth">Entrar com meu acesso<ArrowRight className="ml-2 h-4 w-4" /></Link></Button><a className="quiet-link mt-6" href="https://sucodezap.xyz"><ArrowLeft size={16} />Voltar ao Suco de Zap</a></div>}</main>;
}
