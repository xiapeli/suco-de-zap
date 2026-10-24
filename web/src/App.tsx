import { lazy, Suspense } from 'react';

// Vite replaces this at build time; the Supabase artifact excludes the legacy
// Convex module graph entirely.
const ActiveApp = import.meta.env.VITE_SUCO_CONTROL === 'supabase'
  ? lazy(() => import('./SupabaseApp'))
  : lazy(() => import('./LegacyApp'));

export default function App() {
  return <Suspense fallback={<p className="p-8" role="status">Abrindo o Suco…</p>}>
    <ActiveApp />
  </Suspense>;
}
