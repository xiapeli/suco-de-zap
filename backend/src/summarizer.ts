import { resolvePersonalJuice, SqlPersonalJuiceStore, PersonalJuiceError } from './personal-juices.js';
import { resolveJuicePrompt, composeJuiceModelPrompt } from './juice-catalog.js';
import {createHash,randomUUID}from'node:crypto';
import {authorizeTenant,tenantConfig,advancedAiAllowed,tenantAuthorizer}from'./tenant-context.js';
import {runSummaryWorkflow,SqlSummaryStore,SignedTrialControl,summaryAiPermitted,SummaryError}from'./summary-workflow.js';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { pool, type MessageRow } from './db.js';
import { resolveChatName } from './wa.js';
import { callCloudLLM } from './cloud-runtime.js';

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) {
    if (!config.anthropicApiKey) {
      const err = new Error('Nenhum LLM configurado: defina OPENAI_COMPAT_URL (local) ou ANTHROPIC_API_KEY.');
      (err as any).status = 502;
      throw err;
    }
    anthropic = new Anthropic({
      maxRetries: 0,
      apiKey: config.anthropicApiKey,
      ...(config.anthropicBaseUrl ? { baseURL: config.anthropicBaseUrl } : {}),
    });
  }
  return anthropic;
}

export type LlmPriority = 'high' | 'medium' | 'low';

/**
 * Chama o LLM configurado: local OpenAI-compat (Qwen na faex1) ou Anthropic.
 * `priority` é lida pela llm-queue (busca interativa fura fila de extração);
 * chamando o Qwen direto, o header é simplesmente ignorado.
 */
export async function callLLM(
  prompt: string,
  opts: { priority?: LlmPriority } = {}
): Promise<{ content: string; model: string }> {
  if(tenantConfig&&(!(await authorizeTenant())||(!advancedAiAllowed()&&!summaryAiPermitted())))throw new SummaryError('UPGRADE_REQUIRED',402);
  if (process.env.SUCO_GLM_REGULAR_KEY_FILE) return callCloudLLM(prompt,opts);
  if (config.openaiCompatUrl) {
    const res = await fetch(`${config.openaiCompatUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-priority': opts.priority || 'medium' },
      body: JSON.stringify({
        model: config.openaiCompatModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const err = new Error('O processamento está indisponível. Tente novamente mais tarde.');
      (err as any).status = 502;
      throw err;
    }
    const data: any = await res.json();
    const finish = data.choices?.[0]?.finish_reason;
    if (finish === 'length') {
      const err = new Error('O resumo não ficou completo. Escolha um período menor.');
      (err as Error & {status:number}).status=502; throw err;
    }
    // modelos de raciocínio (Qwen3) podem devolver <think>…</think> antes da resposta
    const rawContent: string = data.choices?.[0]?.message?.content ?? '';
    return {
      content: rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
      model: data.model || config.openaiCompatModel,
    };
  }

  // API oficial: fallback server-side habilitado; proxies Anthropic-compat sem betas.
  const client = getAnthropic();
  const response: any = config.anthropicBaseUrl
    ? await client.messages.create({
        model: config.anthropicModel,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }],
      })
    : await (client.beta.messages.create as any)({
        model: config.anthropicModel,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{ role: 'user', content: prompt }],
      });

  if (response.stop_reason === 'refusal') {
    const err = new Error('A IA recusou esta análise (classificador de segurança).');
    (err as any).status = 502;
    throw err;
  }
  return {
    content: (response.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim(),
    model: response.model || config.anthropicModel,
  };
}

const MEDIA_LABEL: Record<string, string> = {
  image: '[imagem]',
  video: '[vídeo]',
  audio: '[áudio]',
  sticker: '[figurinha]',
  document: '[documento]',
  location: '[localização]',
  contact: '[contato]',
  poll: '[enquete]',
  reaction: '[reação]',
  other: '[mídia]',
};

function fmtDate(d: Date): string {
  return d.toLocaleString('pt-BR', {
    timeZone: config.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function renderTranscript(messages: MessageRow[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.from_me ? 'Eu' : m.sender_name || m.sender_jid?.split('@')[0] || '?';
    const label = m.msg_type === 'text' ? '' : `${MEDIA_LABEL[m.msg_type] || '[mídia]'} `;
    const body = m.body || '';
    if (!label && !body) continue;
    lines.push(`[${fmtDate(m.ts)}] ${who}: ${label}${body}`.trim());
  }
  let transcript = lines.join('\n');
  if (transcript.length > config.maxTranscriptChars) {
    transcript = transcript.slice(-config.maxTranscriptChars);
    transcript = '(… transcript truncado, mostrando as mensagens mais recentes …)\n' + transcript;
  }
  return transcript;
}

function temporalContainment(start: Date, end: Date, count: number, chatName: string): string {
  return `🔒 CONTENÇÃO TEMPORAL ATIVA 🔒

REGRA FUNDAMENTAL: Analise EXCLUSIVAMENTE o período fornecido.

PERÍODO DE ANÁLISE AUTORIZADO:
📅 INÍCIO: ${fmtDate(start)}
📅 FIM: ${fmtDate(end)}
📊 MENSAGENS NO PERÍODO: ${count}
💬 CHAT: ${chatName}

RESTRIÇÕES:
- Não faça suposições sobre mensagens fora deste período.
- Trate este recorte como o universo completo da conversa.
- Mencione o período analisado no início da resposta.
- Responda em português brasileiro, em markdown bem formatado.`;
}

export const DEFAULT_DAILY_PROMPT = `Faça o SUCO DIÁRIO desta conversa — um resumo executivo direto ao ponto:

## 📌 Resumo
O essencial do que aconteceu, em 2-4 frases.

## 💬 Principais assuntos
Os temas discutidos, com citações curtas quando relevante.

## ✅ Decisões e acordos
O que ficou decidido ou combinado.

## 📋 Pendências e ações
O que ficou em aberto, quem deve fazer o quê, prazos mencionados.

## ⚠️ Atenção
Qualquer coisa que exija minha ação ou resposta urgente.

Se o dia foi trivial (só cumprimentos, figurinhas etc.), diga isso em uma linha e não invente conteúdo.`;

export interface GenerateArgs {
  chatJid: string;
  start: Date;
  end: Date;
  analysisType: string;
  basePrompt: string;
  templateVersion?: string;
  personalRevision?: string;
  focus?: string;
  title?: string;
  auto?: boolean;
  requestId?: string;
}

export async function generateSummary(args: GenerateArgs) {
  let personalTypeName:string|null=null;
  if(args.analysisType.startsWith('personal:')) {
    args={...args,basePrompt:await resolvePersonalJuice(pool,tenantConfig?.accountId||'personal',args)};
    personalTypeName=(await new SqlPersonalJuiceStore(pool).get(tenantConfig?.accountId||'personal',args.analysisType.slice(9),args.personalRevision))?.name??null;
  }
  else {if(args.personalRevision!==undefined)throw new PersonalJuiceError('INVALID_PERSONAL_JUICE');args={...args,basePrompt:resolveJuicePrompt(args)};}
  const chatRes = await pool.query('SELECT * FROM wa_chats WHERE jid = $1', [args.chatJid]);
  if (!chatRes.rows[0]) {
    const err = new Error('Chat não encontrado');
    (err as any).status = 404;
    throw err;
  }
  const chatName = await resolveChatName(args.chatJid, chatRes.rows[0].name);

  const msgRes = await pool.query<MessageRow>(
    `SELECT * FROM wa_messages WHERE chat_jid = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC LIMIT 10000`,
    [args.chatJid, args.start, args.end]
  );
  const messages = msgRes.rows;
  if (messages.length === 0) {
    const err = new Error('Nenhuma mensagem no período selecionado');
    (err as any).status = 422;
    throw err;
  }

  const transcript = renderTranscript(messages);
  const prompt = composeJuiceModelPrompt(temporalContainment(args.start, args.end, messages.length, chatName), args.basePrompt, transcript);

  const process=async()=>{const result=await callLLM(prompt);if(!result.content)throw Object.assign(new Error('A IA retornou resposta vazia.'),{status:502});return result;};
  if(tenantConfig&&args.auto&&!advancedAiAllowed())throw new SummaryError('UPGRADE_REQUIRED',402);
  const persist=async({content,model}:{content:string;model:string},id:string)=>{
    const title=args.title||`${personalTypeName?personalTypeName+' — ':''}${chatName} — ${fmtDate(args.start).split(',')[0]} a ${fmtDate(args.end).split(',')[0]}`;
    const ins=await pool.query(`INSERT INTO summaries (id,chat_jid,chat_name,title,analysis_type,period_start,period_end,content,model,auto) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[id,args.chatJid,chatName,title,args.analysisType,args.start,args.end,content,model,!!args.auto]);return ins.rows[0];
  };
  if(!tenantConfig)return persist(await process(),randomUUID());
  const requestId=args.requestId||randomUUID();
  const fingerprint=createHash('sha256').update(JSON.stringify({chatJid:args.chatJid,start:args.start.toISOString(),end:args.end.toISOString(),analysisType:args.analysisType,basePrompt:args.basePrompt,title:args.title||null,auto:!!args.auto,...(args.templateVersion?{templateVersion:args.templateVersion}:{}),...(args.personalRevision?{personalRevision:args.personalRevision}:{})})).digest('hex');
  try{return await runSummaryWorkflow({requestId,fingerprint,store:new SqlSummaryStore(pool),control:new SignedTrialControl(tenantConfig),process,persist});}
  finally{tenantAuthorizer?.invalidate();await authorizeTenant();}
}
