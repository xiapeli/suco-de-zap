export function vaultDestination(query: string): { kind: 'pix' | 'email' | 'phone' | 'address'; label: string } | null {
  const text = query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\bpix\b/.test(text)) return { kind: 'pix', label: 'Pix' };
  if (/\be-?mail\b/.test(text)) return { kind: 'email', label: 'e-mail' };
  if (/\b(?:telefone|celular)\b/.test(text)) return { kind: 'phone', label: 'telefone' };
  if (/\bendereco\b/.test(text)) return { kind: 'address', label: 'endereço' };
  return null;
}

export function searchHandoff(state: unknown): string {
  if (!state || typeof state !== 'object' || !('sucoRequest' in state)) return '';
  const value = (state as { sucoRequest: unknown }).sucoRequest;
  return typeof value === 'string' && value.length <= 500 && !/[\u0000-\u001f]/.test(value) ? value.trim() : '';
}

export function plainExcerpt(value: string): string {
  return value.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/[#*`_~]/g, '').replace(/\s+/g, ' ').trim();
}
