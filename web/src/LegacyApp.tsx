import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Conversations = lazy(() => import("./pages/Conversations"));
const Summaries = lazy(() => import("./pages/Summaries"));
const Digest = lazy(() => import("./pages/Digest"));
const Cofre = lazy(() => import("./pages/Cofre"));
const Settings = lazy(() => import("./pages/Settings"));
import NotFound from "./pages/NotFound";
const Onboarding = lazy(() => import("./pages/Onboarding"));
const Account = lazy(() => import("./pages/Account"));
import { CloudProvider, useCloudEnabled } from "./components/CloudProvider";
import { VaultCacheGuard } from './components/VaultCacheGuard';
const Calendar = lazy(() => import('./pages/Calendar'));
const MyJuiceTypes = lazy(() => import('./pages/MyJuiceTypes'));
const Guide = lazy(() => import('./pages/Guide'));
import { ManagedSession } from "./components/ManagedSession";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, loading } = useAuth();
  const nativeCloud = useCloudEnabled();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Carregando...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to={nativeCloud ? "/account" : "/auth"} replace />;
  }

  return <>{children}</>;
};

const AppRoutes = () => (
  <Suspense fallback={<p role="status" className="p-8 text-sm text-muted-foreground">Abrindo seu espaço…</p>}><Routes>
    <Route path="/auth" element={<Auth />} />
    <Route path="/account" element={<Account />} />
    <Route path="/calendar" element={<ProtectedRoute><Calendar /></ProtectedRoute>} />
    <Route path="/my-juices/*" element={<ProtectedRoute><MyJuiceTypes /></ProtectedRoute>} />
    <Route path="/guide" element={<ProtectedRoute><Guide /></ProtectedRoute>} />
    <Route path="/onboarding" element={<ProtectedRoute><Onboarding /></ProtectedRoute>} />

    <Route
      path="/"
      element={
        <ProtectedRoute>
          <Dashboard />
        </ProtectedRoute>
      }
    />
    <Route
      path="/conversations"
      element={
        <ProtectedRoute>
          <Conversations />
        </ProtectedRoute>
      }
    />
    <Route
      path="/summaries"
      element={
        <ProtectedRoute>
          <Summaries />
        </ProtectedRoute>
      }
    />
    <Route
      path="/digest"
      element={
        <ProtectedRoute>
          <Digest />
        </ProtectedRoute>
      }
    />
    <Route
      path="/cofre"
      element={
        <ProtectedRoute>
          <Cofre />
        </ProtectedRoute>
      }
    />
    <Route
      path="/settings"
      element={
        <ProtectedRoute>
          <Settings />
        </ProtectedRoute>
      }
    />

    {/* Rota antiga do dashboard */}
    <Route path="/dashboard" element={<Navigate to="/" replace />} />

    <Route path="*" element={<NotFound />} />
  </Routes></Suspense>
);

const LegacyApp = () => (
  <CloudProvider><QueryClientProvider client={queryClient}>
    <TooltipProvider>
      {import.meta.env.VITE_SUCO_ENV === 'preview' && <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 text-center text-sm text-amber-950" role="status">Ambiente de teste do Suco. Pagamentos nesta prévia usam o modo de teste, sem cobrança real.</div>}
      <VaultCacheGuard />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <ManagedSession />
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider></CloudProvider>
);

export default LegacyApp;
