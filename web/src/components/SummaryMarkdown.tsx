import React from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import { cn } from '@/lib/utils';
import { Check } from 'lucide-react';

interface SummaryMarkdownProps {
  content: string;
  /**
   * 'digest': leitura diária — seções com mais respiro, headers de emoji
   * destacados e checklists de verdade. 'default' mantém o visual dos sucos.
   */
  variant?: 'default' | 'digest';
}

// ---------- helpers (usados só na variante digest) ----------

const nodeText = (node: React.ReactNode): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement(node)) return nodeText(node.props.children);
  return '';
};

// Separa o emoji inicial do título da seção ("⚡ Precisa de você").
const splitLeadingEmoji = (text: string) => {
  const match = text.match(
    /^((?:\p{Extended_Pictographic}|\p{Emoji_Presentation})[️‍\p{Extended_Pictographic}\p{Emoji_Presentation}]*)\s*(.*)$/u,
  );
  if (match) return { emoji: match[1], label: match[2] };
  return { emoji: null, label: text };
};

// Header de seção do digest: emoji + label em caixa alta, com divisor.
const DigestH2 = ({ children }: { children?: React.ReactNode }) => {
  const { emoji, label } = splitLeadingEmoji(nodeText(children).trim());
  return (
    <h2 className="mb-3 mt-8 flex items-center gap-2 border-b pb-2 first:mt-1">
      {emoji && (
        <span aria-hidden className="text-[15px] leading-none">
          {emoji}
        </span>
      )}
      <span className="text-[13px] font-semibold uppercase tracking-wider">{label}</span>
    </h2>
  );
};

// Item de checklist ("- [ ] tarefa") vira um checkbox visual de verdade.
const DigestLi = ({ children }: { children?: React.ReactNode }) => {
  const parts = React.Children.toArray(children);
  const first = parts[0];
  if (typeof first === 'string') {
    const match = first.match(/^\[([ xX])\]\s+(.*)$/);
    if (match) {
      const done = match[1].toLowerCase() === 'x';
      return (
        <li className="-ml-5 flex list-none items-start gap-2.5">
          <span
            aria-hidden
            className={cn(
              'mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
              done
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-muted-foreground/40 bg-background',
            )}
          >
            {done && <Check className="h-3 w-3" strokeWidth={3} />}
          </span>
          <span className={cn('min-w-0', done && 'text-muted-foreground line-through')}>
            {match[2]}
            {parts.slice(1)}
          </span>
        </li>
      );
    }
  }
  return <li>{children}</li>;
};

// Model output and conversation text are untrusted content. Never load their images.
const safeMarkdownUrl = (value: string) => {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return '';
  if (/^#[A-Za-z0-9_-]+$/.test(value)) return value;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
};
const safeComponents: Components = {
  a: ({href,children}) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
  img: ({alt}) => <span>{alt ? `[Imagem: ${alt}]` : '[Imagem omitida]'}</span>,
};
const digestComponents: Components = {
  ...safeComponents,
  h2: DigestH2,
  li: DigestLi,
};

/**
 * Renderiza o conteúdo markdown de um suco/digest com estilos consistentes,
 * sem depender do plugin de tipografia do Tailwind.
 */
const SummaryMarkdown: React.FC<SummaryMarkdownProps> = ({ content, variant = 'default' }) => {
  const digest = variant === 'digest';
  return (
    <div
      className={cn(
        'break-words',
        digest ? 'text-[15px] leading-relaxed' : 'text-sm leading-relaxed',
        '[&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3',
        // Na variante digest o h2 é um componente próprio (DigestH2).
        !digest && '[&_h2]:text-lg [&_h2]:font-bold [&_h2]:mt-5 [&_h2]:mb-2',
        '[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2',
        digest ? '[&_p]:mb-2.5' : '[&_p]:mb-3',
        digest
          ? '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-4 [&_ul]:space-y-1.5 [&_ul_ul]:mt-1.5 [&_ul_ul]:mb-0 [&_li::marker]:text-muted-foreground/50'
          : '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3 [&_ul]:space-y-1',
        digest
          ? '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-4 [&_ol]:space-y-1.5'
          : '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3 [&_ol]:space-y-1',
        '[&_blockquote]:border-l-4 [&_blockquote]:border-muted [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:mb-3',
        '[&_code]:bg-muted [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
        '[&_pre]:bg-muted [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:mb-3',
        '[&_table]:w-full [&_table]:border-collapse [&_table]:mb-3',
        '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted [&_th]:text-left',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_a]:text-primary [&_a]:underline',
        '[&_strong]:font-semibold',
        digest && '[&_em]:text-muted-foreground',
      )}
    >
      <ReactMarkdown skipHtml urlTransform={safeMarkdownUrl} components={digest ? digestComponents : safeComponents}>{content}</ReactMarkdown>
    </div>
  );
};

export default SummaryMarkdown;
