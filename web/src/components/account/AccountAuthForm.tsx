import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, KeyRound, Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ActivationSteps } from '@/components/onboarding/ActivationSteps';

type Mode = 'signIn' | 'signUp' | 'email-verification' | 'reset' | 'reset-verification';
type SignIn = (provider: string, params: Record<string, string>) => Promise<{ signingIn: boolean }>;

export function AccountAuthForm({ signIn }: { signIn: SignIn }) {
  const [mode, setMode] = useState<Mode>('signUp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resendAfter, setResendAfter] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [visiblePassword, setVisiblePassword] = useState(false);
  const flight = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const verifying = mode === 'email-verification' || mode === 'reset-verification';
  const seconds = Math.max(0, Math.ceil((resendAfter - now) / 1000));
  const title = mode === 'signUp' ? 'Seu WhatsApp tem assunto. Vamos ao que importa.' : mode === 'signIn' ? 'Bom te ver de volta.' : mode === 'reset' ? 'Vamos recuperar seu acesso.' : mode === 'email-verification' ? 'Confira seu e-mail.' : 'Escolha sua nova senha.';
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [mode]);
  useEffect(() => {
    if (!verifying || resendAfter <= Date.now()) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [verifying, resendAfter]);
  function change(next: Mode) {
    if (flight.current) return;
    setMode(next); setError(''); setNotice(''); setCode(''); setPassword(''); setVisiblePassword(false);
  }
  function codeSent() { setNow(Date.now()); setResendAfter(Date.now() + 30_000); }
  async function resend() {
    if (flight.current || seconds > 0 || !verifying) return;
    flight.current = true; setPending(true); setError(''); setNotice('');
    try {
      // Both flows send a new code without recreating the account or changing its password.
      await signIn('password', { email: email.trim().toLowerCase(), flow: mode === 'email-verification' ? 'email-verification' : 'reset' });
      setCode(''); codeSent(); setNotice('Novo código enviado. Use o mais recente e confira também o spam.');
    } catch { setError('Não conseguimos reenviar agora. Aguarde um pouco e tente novamente. Seu acesso não foi alterado.'); }
    finally { flight.current = false; setPending(false); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (flight.current) return;
    flight.current = true; setPending(true); setError(''); setNotice('');
    try {
      const input: Record<string, string> = { email: email.trim().toLowerCase(), flow: mode };
      if (mode === 'signIn' || mode === 'signUp') input.password = password;
      if (verifying) input.code = code;
      if (mode === 'reset-verification') input.newPassword = password;
      const result = await signIn('password', input);
      if (!result.signingIn && (mode === 'signIn' || mode === 'signUp')) { setMode('email-verification'); setPassword(''); setCode(''); codeSent(); }
      else if (mode === 'reset') { setMode('reset-verification'); setPassword(''); setCode(''); codeSent(); }
      else if (verifying && !result.signingIn) setError('O código ainda não foi confirmado. Confira os 8 dígitos ou peça outro código.');
    } catch {
      setError(verifying ? 'Esse código não pôde ser confirmado. Confira os 8 dígitos ou peça outro código.' : mode === 'signIn' ? 'Não conseguimos entrar. Confira seu e-mail e sua senha ou use Esqueci minha senha.' : mode === 'reset' ? 'Não conseguimos enviar o código. Confira o e-mail da sua conta e tente novamente.' : 'Não conseguimos concluir. Se você já criou sua conta, escolha Já tenho conta para entrar ou confirmar seu e-mail.');
    } finally { flight.current = false; setPending(false); }
  }
  return <div className="account-auth">
    <a href="https://sucodezap.xyz" aria-label="Suco de Zap — página inicial"><img src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png" alt="Suco de Zap" width="72" height="72" /></a>
    <ActivationSteps current={0}/><h1 ref={heading} tabIndex={-1} className="outline-none">{title}</h1>
    <p>{verifying ? `Enviamos um código de 8 dígitos para ${email.trim().toLowerCase()}. Ele vale por 10 minutos. Confira também o spam.` : mode === 'reset' ? 'Digite o e-mail da sua conta para receber o código de recuperação.' : 'Resumos, combinados e busca nas suas conversas. Sem enviar mensagens por você.'}</p>
    <form onSubmit={submit} className="space-y-5 mt-7" aria-busy={pending}>
      <div className="space-y-2"><Label htmlFor="account-email">Seu e-mail</Label><Input id="account-email" type="email" value={email} onChange={e => { setEmail(e.target.value); setError(''); }} autoComplete="email" required maxLength={254} disabled={verifying || pending}/></div>
      {verifying && <div className="space-y-2"><Label htmlFor="account-code">Código de 8 dígitos</Label><Input id="account-code" inputMode="numeric" pattern="[0-9]{8}" autoComplete="one-time-code" value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 8)); setError(''); }} required minLength={8} maxLength={8} disabled={pending} aria-invalid={!!error} aria-describedby="code-help"/><p id="code-help" className="text-sm text-muted-foreground">Use o código mais recente que chegou ao seu e-mail.</p></div>}
      {(mode === 'signIn' || mode === 'signUp' || mode === 'reset-verification') && <div className="space-y-2"><div className="flex items-center justify-between gap-3"><Label htmlFor="account-password">{mode === 'reset-verification' ? 'Nova senha' : 'Senha'}</Label><button type="button" className="quiet-link min-h-11" disabled={pending} aria-controls="account-password" aria-pressed={visiblePassword} onClick={() => setVisiblePassword(value => !value)}>{visiblePassword ? 'Ocultar senha' : 'Mostrar senha'}</button></div><Input id="account-password" type={visiblePassword ? 'text' : 'password'} value={password} onChange={e => { setPassword(e.target.value); setError(''); }} autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} required minLength={mode === 'signIn' ? 1 : 12} maxLength={128} disabled={pending} aria-describedby="password-help"/><p id="password-help" className="text-sm text-muted-foreground">{mode === 'signIn' ? 'A senha da sua conta Suco de Zap.' : 'Use pelo menos 12 caracteres. Você pode colar uma senha do seu gerenciador.'}</p></div>}
      {error && <div className="flow-error" role="alert">{error}</div>}
      {notice && <p className="flow-notice" role="status">{notice}</p>}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>{pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : verifying ? <Mail className="mr-2 h-4 w-4"/> : <KeyRound className="mr-2 h-4 w-4"/>}{pending ? 'Conferindo…' : mode === 'signUp' ? 'Criar minha conta grátis' : mode === 'signIn' ? 'Entrar no meu espaço' : mode === 'reset' ? 'Enviar código de recuperação' : mode === 'reset-verification' ? 'Salvar senha e entrar' : 'Confirmar meu e-mail'}</Button>
    </form>
    <div className="account-auth-options">{verifying ? <><Button variant="outline" disabled={pending || seconds > 0} onClick={resend}>{seconds > 0 ? `Reenviar código em ${seconds}s` : 'Reenviar código'}</Button><Button variant="ghost" disabled={pending} onClick={() => change(mode === 'email-verification' ? 'signUp' : 'reset')}><ArrowLeft size={16}/>Corrigir e-mail</Button></> : <>{mode === 'signUp' ? <Button variant="ghost" disabled={pending} onClick={() => change('signIn')}>Já tenho conta<ArrowRight size={16}/></Button> : <Button variant="ghost" disabled={pending} onClick={() => change('signUp')}>Criar uma conta grátis</Button>}{mode === 'signIn' && <Button variant="ghost" disabled={pending} onClick={() => change('reset')}>Esqueci minha senha</Button>}</>}</div>
    <p className="text-sm text-muted-foreground mt-5 leading-relaxed">Comece com 3 sucos grátis, sem cartão. Criar a conta não cobra nada nem conecta seu WhatsApp; você autoriza a leitura antes de conectar.</p>
  </div>;
}
