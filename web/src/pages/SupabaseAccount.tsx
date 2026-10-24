import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowRight, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { getSucoSupabase } from '@/lib/supabase';
import SupabaseWorkspace from './SupabaseWorkspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type AccountStatus = {
  accountId: string;
  email: string;
  entitlement: string;
  legacyLinked: boolean;
  resetPending: boolean;
  privateState: string;
  admissionMode: string;
  tenantCapacity: number;
};
type Mode = 'signIn' | 'recover' | 'changePassword';

const linkType = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type') ??
  new URLSearchParams(window.location.search).get('type');
const enteringFromEmail = linkType === 'invite' || linkType === 'recovery';
const client = getSucoSupabase();
const redirectTo = `${window.location.origin}/account`;

function isAccountStatus(value: unknown): value is AccountStatus {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.accountId === 'string' && typeof item.email === 'string' &&
    typeof item.privateState === 'string' && typeof item.resetPending === 'boolean' &&
    typeof item.admissionMode === 'string';
}

export default function SupabaseAccount() {
  const emailLinkHandled = useRef(false);
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [mode, setMode] = useState<Mode>(enteringFromEmail ? 'changePassword' : 'signIn');
  const [linkTimedOut, setLinkTimedOut] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refreshAccount() {
    if (!client || !session) return;
    setPending(true); setError('');
    try {
      const { data, error: rpcError } = await client.rpc('suco_account_status');
      if (rpcError || !isAccountStatus(data) || data.accountId !== session.user.id)
        throw Error('ACCOUNT_UNAVAILABLE');
      setAccount(data);
    } catch {
      setError('Não conseguimos conferir sua conta. Tente novamente em instantes.');
    } finally { setPending(false); }
  }

  useEffect(() => {
    if (!client) { setInitializing(false); return; }
    const { data } = client.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setInitializing(false);
      if (event === 'PASSWORD_RECOVERY' ||
          (enteringFromEmail && !emailLinkHandled.current && event === 'SIGNED_IN')) {
        emailLinkHandled.current = true;
        setMode('changePassword');
      }
      if (event === 'SIGNED_OUT') setAccount(null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (mode !== 'changePassword' || session) { setLinkTimedOut(false); return; }
    const timer = window.setTimeout(() => setLinkTimedOut(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [mode, session]);

  useEffect(() => {
    if (!client || !session || mode === 'changePassword') return;
    let live = true;
    setAccount(null);
    client.rpc('suco_account_status').then(({ data, error: rpcError }) => {
      if (!live) return;
      if (rpcError || !isAccountStatus(data) || data.accountId !== session.user.id) {
        setError('Confirme seu email para abrir a conta. Se já confirmou, saia e entre novamente.');
        return;
      }
      setError('');
      setAccount(data);
    });
    return () => { live = false; };
  }, [session?.user.id, mode]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!client || pending) return;
    setPending(true); setError(''); setNotice('');
    try {
      if (mode === 'recover') {
        const result = await client.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
        if (result.error) throw result.error;
        setNotice('Se esse email já tem acesso, enviamos um link de recuperação. Confira a caixa de entrada e o spam.');
      } else if (mode === 'changePassword') {
        if (!session) { setError('O link ainda não foi confirmado. Aguarde um instante ou peça um novo.'); return; }
        if (password.length < 12) { setError('Use uma senha com pelo menos 12 caracteres.'); return; }
        const result = await client.auth.updateUser({ password });
        if (result.error) throw result.error;
        emailLinkHandled.current = true;
        window.history.replaceState(null, '', window.location.pathname);
        setPassword(''); setMode('signIn');
        setNotice('Senha salva. Agora você pode abrir sua conta.');
      } else {
        const result = await client.auth.signInWithPassword({
          email: email.trim().toLowerCase(), password,
        });
        if (result.error) throw result.error;
        setPassword('');
      }
    } catch {
      setError(mode === 'signIn'
        ? 'Não conseguimos entrar. Confira email e senha e confirme o link recebido.'
        : 'Não conseguimos concluir agora. Verifique o email e tente novamente.');
    } finally {
      setPending(false);
    }
  }

  async function leaveAccount() {
    if (!client || pending) return;
    setPending(true); setError('');
    try {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
    } catch {
      setError('Não conseguimos sair desta sessão. Tente novamente.');
    } finally { setPending(false); }
  }

  if (!client) return <main className="account-page"><section className="account-auth" role="alert"><h1>A entrada ainda está em preparação.</h1><p>A configuração da nova conta não foi publicada.</p></section></main>;
  if (initializing) return <main className="account-page"><p className="p-8" role="status">Conferindo sua sessão…</p></main>;
  if (mode === 'changePassword' && !session) return <main className="account-page"><section className="account-auth">
    <h1>{linkTimedOut ? 'Não conseguimos confirmar este link.' : 'Confirmando seu convite…'}</h1>
    <p role="status">{linkTimedOut ? 'O link pode ter expirado ou já ter sido usado. Peça outro para definir sua senha.' : 'Aguarde enquanto validamos o acesso com o Supabase.'}</p>
    {linkTimedOut && <Button className="mt-6" onClick={() => { setMode('recover'); setError(''); }}>Pedir novo link</Button>}
  </section></main>;
  if (session && mode !== 'changePassword' && account?.privateState === 'active')
    return <SupabaseWorkspace session={session} account={account} onSignOut={async () => {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
    }} />;

  return <main className="account-page"><div className="account-auth">
    <a href="https://sucodezap.xyz" aria-label="Suco de Zap — página inicial"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="Suco de Zap" width="72" height="72" /></a>
    {session && mode !== 'changePassword' ? <>
      <h1>Seu espaço no Suco de Zap.</h1>
      {account ? <section className="account-section" role="status"><ShieldCheck className="text-primary" />
        <h2>{account.legacyLinked ? 'Sua conta existente foi reconhecida.' : 'Conta confirmada.'}</h2>
        <p>{account.legacyLinked ? 'Seu vínculo anterior foi preservado. A abertura do espaço privado ainda está em preparação.' : 'Seu espaço privado ainda está em preparação.'}</p>
        <p className="text-sm">Assim que o processamento privado for ativado nesta conta, você poderá abrir seu espaço e ler o QR no seu telefone.</p>
        <Button variant="outline" className="mt-5" disabled={pending} onClick={refreshAccount}><RefreshCw className="mr-2 h-4 w-4" />Conferir ativação</Button>
      </section> : !error && <p role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> Conferindo sua conta…</p>}
      <Button variant="outline" className="mt-6" disabled={pending} onClick={leaveAccount}>Sair da conta</Button>
    </> : <>
      <h1>{mode === 'recover' ? 'Recuperar acesso.' : mode === 'changePassword' ? 'Escolha sua nova senha.' : 'Entre na sua conta.'}</h1>
      <p>{mode === 'signIn' ? 'Entre para abrir seu espaço privado e conferir a conexão do WhatsApp. O cadastro público permanece fechado.' : mode === 'recover' ? 'Enviaremos um link ao email de uma conta já ativada.' : 'Crie uma senha para usar sua conta. Depois, siga a configuração do seu espaço privado.'}</p>
      <form onSubmit={submit} className="space-y-5 mt-7" aria-busy={pending}>
        {mode !== 'changePassword' && <div className="space-y-2"><Label htmlFor="supabase-email">Seu email</Label><Input id="supabase-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={pending} /></div>}
        {mode !== 'recover' && <div className="space-y-2"><Label htmlFor="supabase-password">{mode === 'changePassword' ? 'Nova senha' : 'Senha'}</Label><Input id="supabase-password" type="password" autoComplete={mode === 'changePassword' ? 'new-password' : 'current-password'} required minLength={mode === 'changePassword' ? 12 : 1} value={password} onChange={e => setPassword(e.target.value)} disabled={pending} /></div>}
        {error && <p className="flow-error" role="alert">{error}</p>}
        {notice && <p className="flow-notice" role="status">{notice}</p>}
        <Button type="submit" className="w-full" size="lg" disabled={pending}>{pending ? 'Conferindo…' : mode === 'recover' ? 'Enviar link de recuperação' : mode === 'changePassword' ? 'Salvar nova senha' : 'Entrar'}<ArrowRight className="ml-2 h-4 w-4" /></Button>
      </form>
      {mode !== 'changePassword' && <Button variant="ghost" className="mt-4" disabled={pending} onClick={() => { setMode(mode === 'recover' ? 'signIn' : 'recover'); setError(''); setNotice(''); }}>{mode === 'recover' ? 'Voltar para entrar' : 'Esqueci minha senha'}</Button>}
    </>}
    {error && session && mode !== 'changePassword' && <p className="flow-error mt-4" role="alert">{error}</p>}
  </div></main>;
}
