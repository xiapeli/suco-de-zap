// Vite replaces the exact `import.meta.env` chain at build time; the ?? keeps
// plain node test runs (import.meta.env undefined) on the legacy path instead
// of crashing on the first control-mode read.
export const sucoEnv = (import.meta.env ?? {}) as ImportMetaEnv;

export function controlMode(): 'supabase' | 'legacy' {
  return sucoEnv.VITE_SUCO_CONTROL === 'supabase' ? 'supabase' : 'legacy';
}
