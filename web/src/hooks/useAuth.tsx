import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, clearToken, setApiUrl, clearVaultSession, validateApiUrl, ApiError } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { clearDrafts } from '@/lib/onboarding-state';

export interface AuthUser {
  name: string;
  jid?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  /** Valida o token contra GET /api/status e, se válido, salva e autentica. */
  login: (token: string, apiUrl?: string) => Promise<{ error: string | null }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Na inicialização: se existe token salvo, considera autenticado
  // e tenta enriquecer com o nome vindo de /api/status.
  useEffect(() => {
    let mounted = true;
    const token = getToken();

    if (!token) {
      setLoading(false);
      return;
    }

    // Token presente = sessão válida até prova em contrário (401 derruba via api.ts)
    setUser({ name: 'Você' });
    setLoading(false);

    api
      .status()
      .then((status) => {
        if (!mounted) return;
        if (status.me) {
          setUser({ name: status.me.name || 'Você', jid: status.me.jid });
        }
      })
      .catch((error) => {
        if (!mounted) return;
        if (error instanceof ApiError && error.status === 401) {
          // api.ts já limpou o token e redirecionou
          setUser(null);
        }
        // Erro de rede: mantém sessão local, as páginas mostram o erro
      });

    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(async (token: string, apiUrl?: string) => {
    const trimmed = token.trim();
    if (!trimmed) {
      return { error: 'Informe o token da API.' };
    }

    const baseUrl = apiUrl?.trim() ? apiUrl.trim().replace(/\/+$/, '') : undefined;
    if (baseUrl) { try { validateApiUrl(baseUrl); } catch { return {error:'Use o endereço de conexão oficial fornecido pelo Suco.'}; } }

    try {
      const status = await api.validate(trimmed, baseUrl);
      clearVaultSession();
      queryClient.clear();
      // Válido: persiste token (e URL, se informada) e autentica
      setToken(trimmed);
      setApiUrl(baseUrl ?? null);
      setUser({
        name: status.me?.name || 'Você',
        jid: status.me?.jid,
      });
      return { error: null };
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          return { error: 'Token inválido. Confira o API_TOKEN do servidor.' };
        }
        return { error: `Erro do servidor: ${error.message}` };
      }
      return {
        error: 'Não foi possível conectar ao servidor. Confira a URL e se o backend está no ar.',
      };
    }
  }, []);

  const logout = useCallback(() => {
    try { clearDrafts(localStorage); } catch { /* Account logout still works without storage. */ }
    queryClient.clear();
    clearToken();
    setUser(null);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => { if ((event.key === 'wzp_token' && event.newValue === null) || event.key === null) logout(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [logout]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth deve ser usado dentro de <AuthProvider>');
  }
  return context;
};
