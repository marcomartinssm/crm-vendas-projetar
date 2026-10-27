// Entrada do CRM Vendas: recebe as mensagens do WhatsApp (Evolution) dos números de vendas e coloca os contatos
// novos na tela "Entrada" (crm_vendas_entrada, via crm_vendas_entrada_registrar). Mesmo modelo do crm-aluguel-entrada.
// A outra fonte da Entrada (contatos marcados "Vendas" no CRM Aluguel) é um gatilho no banco, não passa por aqui.
//
// Ações (todas com ?token=... — crm_vendas_relatorio_config, chave 'token'):
//   POST (sem acao)                         webhook da Evolution (eventos messages.upsert e send.message)
//   GET  acao=instancias                    números da Evolution e para onde cada um manda o webhook hoje (só leitura)
//   GET  acao=webhook_atual&instancia=X     webhook configurado hoje na instância
//   POST acao=ligar_webhook&instancia=X     aponta o webhook da instância para esta função (só instâncias em entrada_instancias)
//
// Números de vendas atendidos: crm_vendas_relatorio_config.entrada_instancias (nomes separados por vírgula).
// Segredo usado (já existe no projeto): EVOLUTION_API_KEY

import { createClient } from "npm:@supabase/supabase-js@2";

const EVOLUTION_URL = Deno.env.get("EVOLUTION_URL") ?? "https://dinastia-evolution.saxddq.easypanel.host";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const json = { "Content-Type": "application/json; charset=utf-8" };
const responder = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status, headers: json });

async function evo(caminho: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${EVOLUTION_URL}${caminho}`, {
      ...init, signal: ctrl.signal,
      headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const texto = await res.text();
    let corpo: unknown = texto;
    try { corpo = JSON.parse(texto); } catch { /* texto */ }
    return { ok: res.ok, status: res.status, corpo };
  } finally {
    clearTimeout(t);
  }
}

async function config(): Promise<Record<string, string>> {
  const { data } = await db.from("crm_vendas_relatorio_config").select("chave, valor");
  return Object.fromEntries((data ?? []).map((x: any) => [x.chave, x.valor]));
}

// ---------- utilidades (mesmas regras do crm-aluguel-entrada) ----------

function textoDaMensagem(msg: any): string {
  msg = msg ?? {};
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption ? `[foto] ${msg.imageMessage.caption}` : "[foto]";
  if (msg.videoMessage) return msg.videoMessage.caption ? `[vídeo] ${msg.videoMessage.caption}` : "[vídeo]";
  if (msg.audioMessage) return "[áudio]";
  if (msg.documentMessage) return `[documento] ${msg.documentMessage.fileName ?? ""}`.trim();
  if (msg.documentWithCaptionMessage) return "[documento]";
  if (msg.stickerMessage) return "[figurinha]";
  if (msg.locationMessage) return "[localização]";
  if (msg.contactMessage || msg.contactsArrayMessage) return "[contato]";
  if (msg.reactionMessage || msg.protocolMessage) return "";
  if (msg.editedMessage) return "[mensagem editada]";
  const t = msg.templateMessage?.hydratedTemplate ?? msg.templateMessage?.hydratedFourRowTemplate;
  if (t?.hydratedContentText) return t.hydratedContentText;
  if (msg.buttonsMessage?.contentText) return msg.buttonsMessage.contentText;
  if (msg.listMessage?.description) return msg.listMessage.description;
  if (msg.viewOnceMessage?.message) return textoDaMensagem(msg.viewOnceMessage.message);
  if (msg.ephemeralMessage?.message) return textoDaMensagem(msg.ephemeralMessage.message);
  const chaves = Object.keys(msg).filter((k) => k !== "messageContextInfo");
  return chaves.length ? `[${chaves[0]}]` : "";
}

function numeroLimpo(jid: string, alt?: string | null): string {
  const base = (alt && alt.includes("@s.whatsapp.net")) ? alt : jid;
  return (base ?? "").split("@")[0].replace(/\D/g, "");
}

const ehConversaDeCliente = (jid: string) => !!jid && !(jid.endsWith("@g.us") || jid.includes("broadcast") || jid.includes("newsletter"));
const ultimos8 = (n: string) => String(n ?? "").replace(/\D/g, "").slice(-8);

// Números da casa (donos das instâncias e corretores) não entram na Entrada.
let cacheInternos: { numeros: Set<string>; ate: number } | null = null;
async function numerosInternos(): Promise<Set<string>> {
  if (cacheInternos && cacheInternos.ate > Date.now()) return cacheInternos.numeros;
  const numeros = new Set<string>();
  const r = await evo("/instance/fetchInstances");
  for (const i of Array.isArray(r.corpo) ? r.corpo : []) {
    const d = (i as any).instance ?? i;
    const n = ultimos8(String(d.ownerJid ?? d.owner ?? "").split("@")[0]);
    if (n.length === 8) numeros.add(n);
  }
  const { data } = await db.from("corretores").select("telefone");
  for (const c of data ?? []) {
    const n = ultimos8(c.telefone);
    if (n.length === 8) numeros.add(n);
  }
  cacheInternos = { numeros, ate: Date.now() + 10 * 60 * 1000 };
  return numeros;
}

async function receberMensagem(instancia: string, d: any) {
  const key = d?.key ?? {};
  const jid: string = key.remoteJid ?? "";
  if (!ehConversaDeCliente(jid)) return { ignorado: "grupo ou lista" };
  const telefone = numeroLimpo(jid, key.remoteJidAlt ?? key.senderPn ?? null);
  if (ultimos8(telefone).length < 8) return { ignorado: "sem telefone" };
  if ((await numerosInternos()).has(ultimos8(telefone))) return { ignorado: "número interno" };
  const texto = textoDaMensagem(d?.message);
  const deMim = !!key.fromMe;
  if (!deMim && !texto) return { ignorado: "sem texto" };
  const seg = Number(d?.messageTimestamp ?? 0);
  const quando = new Date(seg > 0 ? seg * 1000 : Date.now()).toISOString();
  const { data, error } = await db.rpc("crm_vendas_entrada_registrar", {
    p_fonte: "whatsapp", p_instancia: instancia, p_telefone: telefone, p_jid: jid,
    p_nome: deMim ? null : (d?.pushName ?? null), p_texto: texto, p_quando: quando, p_de_mim: deMim,
  });
  if (error) throw error;
  return { entrada: data, de_mim: deMim };
}

// ---------- diagnóstico ----------

const hostDe = (u: unknown) => { try { const x = new URL(String(u)); return x.host + x.pathname; } catch { return u ? "?" : null; } };

async function instancias() {
  const r = await evo("/instance/fetchInstances");
  const lista = Array.isArray(r.corpo) ? r.corpo : [];
  const out = [];
  for (const i of lista) {
    const d = (i as any).instance ?? i;
    const nome = d.name ?? d.instanceName;
    const dono = String(d.ownerJid ?? d.owner ?? "").split("@")[0];
    const w = await evo(`/webhook/find/${encodeURIComponent(nome)}`);
    const wb: any = w.corpo ?? {};
    out.push({
      nome, conexao: d.connectionStatus ?? d.status ?? null, perfil: d.profileName ?? null,
      numero_final: dono ? dono.slice(-4) : null,
      webhook: wb?.enabled === false ? "desligado" : hostDe(wb?.url ?? wb?.webhook?.url), eventos: wb?.events ?? wb?.webhook?.events ?? null,
    });
  }
  return { ok: r.ok, total: out.length, instancias: out };
}

// ---------- servidor ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cfg = await config();
  const token = url.searchParams.get("token");
  if (!token || token !== cfg.token) return responder({ erro: "token inválido" }, 401);
  if (!EVOLUTION_API_KEY) return responder({ erro: "Falta o segredo EVOLUTION_API_KEY no Supabase." }, 500);

  const permitidas = new Set(String(cfg.entrada_instancias ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const acao = url.searchParams.get("acao");
  const instParam = url.searchParams.get("instancia") ?? "";

  try {
    if (acao === "instancias") return responder(await instancias());
    if (acao === "webhook_atual") return responder((await evo(`/webhook/find/${encodeURIComponent(instParam)}`)).corpo);
    if (acao === "ligar_webhook" && req.method === "POST") {
      if (!permitidas.has(instParam)) return responder({ erro: "instância fora de crm_vendas_relatorio_config.entrada_instancias" }, 400);
      const destino = `${SUPABASE_URL}/functions/v1/crm-vendas-entrada?token=${token}`;
      const r = await evo(`/webhook/set/${encodeURIComponent(instParam)}`, {
        method: "POST",
        body: JSON.stringify({ webhook: { enabled: true, url: destino, byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "SEND_MESSAGE"] } }),
      });
      return responder({ ok: r.ok, status: r.status, resposta: r.corpo }, r.ok ? 200 : 502);
    }
    if (acao) return responder({ erro: "acao desconhecida" }, 400);

    // Webhook da Evolution
    const corpo = await req.json().catch(() => null);
    if (!corpo) return responder({ ignorado: "sem corpo" });
    const evento = String(corpo.event ?? "").toLowerCase().replace("_", ".");
    const instancia = corpo.instance ?? instParam;
    if (evento !== "messages.upsert" && evento !== "send.message") return responder({ ignorado: `evento ${corpo.event}` });
    if (!permitidas.has(instancia)) return responder({ ignorado: `instância ${instancia}` });
    const itens = Array.isArray(corpo.data) ? corpo.data : [corpo.data];
    const resultados = [];
    for (const d of itens) resultados.push(await receberMensagem(instancia, d));
    return responder({ ok: true, resultados });
  } catch (e) {
    console.error(e);
    return responder({ erro: String((e as Error)?.message ?? e) }, 500);
  }
});
