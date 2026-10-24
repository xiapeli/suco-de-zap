import React, { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { getApiUrl } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { KeyRound, Server, ChevronDown, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useCloudEnabled } from '@/components/CloudProvider';

const LegacyAuth = () => {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [token, setToken] = useState('');
  const [apiUrl, setApiUrlInput] = useState(localStorage.getItem('wzp_api_url') || '');
  const [showServer, setShowServer] = useState(!!localStorage.getItem('wzp_api_url'));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = await login(token, apiUrl || undefined);
    setSubmitting(false);

    if (result.error) {
      setError(result.error);
    } else {
      try {
        const dashboard = await api.dashboard();
        navigate(dashboard.summaries > 0 ? '/' : '/onboarding', { replace: true });
      } catch { navigate('/onboarding', { replace: true }); }
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f5f8f5] p-4">
      <Card className="w-full max-w-md shadow-none rounded-2xl">
        <CardHeader className="text-center space-y-3">
          <img
            src="/lovable-uploads/760f3a4d-9f9b-4d74-993c-799ca2cbb297.png"
            alt="Suco de Zap"
            className="w-16 h-16 object-contain mx-auto"
          />
          <CardTitle className="text-2xl">Suco de Zap</CardTitle>
          <CardDescription>
            Seus combinados, decisões e conversas, num lugar só. Entre com o acesso recebido na ativação assistida.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="token" className="flex items-center gap-2">
                <KeyRound className="h-4 w-4" />
                Código de acesso
              </Label>
              <Input
                id="token"
                type="password"
                placeholder="Cole o código do seu convite"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="min-h-12 text-base"
                autoComplete="off"
              />
            </div>

            <Collapsible open={showServer} onOpenChange={setShowServer}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between text-muted-foreground"
                >
                  <span className="flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    Endereço de conexão do convite
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${showServer ? 'rotate-180' : ''}`}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <Input
                  id="apiUrl"
                  aria-label="Endereço de conexão do convite"
                  type="url"
                  placeholder={getApiUrl()}
                  value={apiUrl}
                  onChange={(e) => setApiUrlInput(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Use o endereço enviado na sua ativação. Seu código só será enviado a esse endereço.
                </p>
              </CollapsibleContent>
            </Collapsible>

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <Button type="submit" className="w-full" disabled={submitting || !token.trim()}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Conferindo seu acesso…
                </>
              ) : (
                'Entrar'
              )}
            </Button>
          </form>

          <p className="text-sm leading-relaxed text-muted-foreground mt-6 border-t pt-4">
            O Suco funciona somente em leitura. Antes de conectar o WhatsApp, você verá como suas conversas serão processadas e poderá autorizar esse acesso.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default function Auth() {
  const nativeCloud = useCloudEnabled();
  return nativeCloud ? <Navigate to="/account" replace /> : <LegacyAuth />;
}
