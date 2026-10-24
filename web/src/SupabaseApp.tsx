import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';

const Account = lazy(() => import('./pages/SupabaseAccount'));
const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export default function SupabaseApp() {
  return <QueryClientProvider client={client}><TooltipProvider>
    <Toaster /><Sonner /><BrowserRouter>
      <Suspense fallback={<p className="p-8" role="status">Abrindo sua conta…</p>}>
        <Routes>
          <Route path="/*" element={<Account />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </TooltipProvider></QueryClientProvider>;
}
