// Relatórios do pré-atendimento (SDR) do CRM Vendas no WhatsApp: diário, semanal e mensal, enviados num grupo.
// Mesmo modelo dos relatórios do CRM Aluguel (crm-aluguel-entrada/relatorio.ts).
//
// Ações (todas com ?token=... — o token fica em crm_vendas_relatorio_config, chave 'token'):
//   POST acao=relatorio&tipo=dia|semana|mes[&teste=1][&forcar=1]   monta e envia (teste=1 só devolve o texto)
//   GET  acao=grupos                                               grupos do número que envia (para achar o id do grupo)
//   POST acao=avisos[&teste=1]                                     envia os avisos pendentes aos corretores (pg_cron a cada 2 min)
//
// Os números vêm de crm_vendas_sdr_resumo(inicio, fim, corretor), um bloco para cada SDR em crm_vendas_config.sdrs.
// Quem envia e para onde: crm_vendas_relatorio_config (instancia e grupo — id do grupo, termina em @g.us).
// Segredo usado (já existe no projeto): EVOLUTION_API_KEY

import { createClient } from "npm:@supabase/supabase-js@2";

const EVOLUTION_URL = Deno.env.get("EVOLUTION_URL") ?? "https://dinastia-evolution.saxddq.easypanel.host";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

const FUSO_MS = 3 * 3600 * 1000; // Brasília = UTC-3

type TipoRelatorio = "dia" | "semana" | "mes";

const json = { "Content-Type": "application/json; charset=utf-8" };
function responder(corpo: unknown, status = 200) {
  return new Response(JSON.stringify(corpo), { status, headers: json });
}

async function evo(caminho: string, init?: RequestInit) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${EVOLUTION_URL}${caminho}`, {
      ...init,
      signal: ctrl.signal,
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

// ---------- período (dias em horário de Brasília) ----------

function meiaNoiteBR(a: number, m: number, d: number) {
  return new Date(Date.UTC(a, m, d) + FUSO_MS);
}

function hojeBR() {
  const t = new Date(Date.now() - FUSO_MS);
  return { a: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

function ddmm(dt: Date) {
  const t = new Date(dt.getTime() - FUSO_MS);
  return `${String(t.getUTCDate()).padStart(2, "0")}/${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
}

// dia = hoje; semana = sábado a sexta (enviado no sábado); mês = mês passado.
function periodo(tipo: TipoRelatorio) {
  const h = hojeBR();
  if (tipo === "dia") {
    const inicio = meiaNoiteBR(h.a, h.m, h.d);
    return { inicio, fim: meiaNoiteBR(h.a, h.m, h.d + 1), titulo: "Relatório diário", rotulo: `${DIAS[h.dow]}, ${ddmm(inicio)}/${h.a}` };
  }
  if (tipo === "semana") {
    const desdeSabado = (h.dow + 1) % 7;
    const fim = meiaNoiteBR(h.a, h.m, h.d - desdeSabado);
    const inicio = new Date(fim.getTime() - 7 * 86400000);
    return { inicio, fim, titulo: "Relatório semanal", rotulo: `sáb ${ddmm(inicio)} a sex ${ddmm(new Date(fim.getTime() - 86400000))}` };
  }
  const inicio = meiaNoiteBR(h.a, h.m - 1, 1);
  const t = new Date(inicio.getTime() - FUSO_MS);
  return { inicio, fim: meiaNoiteBR(h.a, h.m, 1), titulo: "Relatório mensal", rotulo: `${MESES[t.getUTCMonth()]} de ${t.getUTCFullYear()}` };
}

// ---------- texto ----------

function pct(a: number, b: number) {
  return b ? `${Math.round((a / b) * 100)}%` : "–";
}

function tempo(min: number | null) {
  if (min == null) return "–";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  }
  return `${Math.round(min / 1440)} dias`;
}

const n = (o: any, k: string) => Number(o?.[k] ?? 0);
const lista = (o: Record<string, number>) => Object.entries(o ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
const ROTULO_ETAPA: Record<string, string> = {
  novo: "Novo lead", contato: "em contato", atendimento: "Em atendimento", agendamento: "Agendamento",
  nutricao: "Nutrição", visita: "Visita", proposta: "Proposta",
};
const curta = (fase: string) => fase.replaceAll(" Contato Feito", " contato").replace("Agendamento de visita", "Agendamento");

function blocoSdr(nome: string, d: any, tipo: TipoRelatorio) {
  const p = d.periodo, c = d.carteira, dep = d.depois, pe = p.para_etapa ?? {};
  const l: string[] = [];
  l.push(`*👤 ${nome}*`);
  l.push("");

  l.push("*O que foi feito*");
  const contatos = p.contatos ? ` (${p.contatos} contato${p.contatos > 1 ? "s" : ""} registrado${p.contatos > 1 ? "s" : ""}: ${lista(p.contatos_por_tipo)})` : "";
  l.push(`• Leads trabalhados: *${p.trabalhados}*${contatos}`);
  l.push(`• Mudaram de etapa: ${p.leads_movidos} · avançaram: *${p.avancaram}*`);
  if (n(pe, "contato")) l.push(`• Contato feito: ${n(pe, "contato")} (${curta(lista(p.para_contato))})`);
  l.push(`• ✅ Responderam → Em atendimento: *${p.chegaram_atendimento}*`);
  l.push(`• 📅 Visitas agendadas: *${n(pe, "agendamento")}*`);
  if (p.reativados_nutricao) l.push(`• 🔁 Tirados do hibernado/nutrição: ${p.reativados_nutricao}`);
  if (n(pe, "nutricao")) l.push(`• 💤 Programados na nutrição: ${n(pe, "nutricao")}`);
  l.push(`• ❌ Descartados: ${n(pe, "descartado")}${n(pe, "perdido") ? ` · Perdidos: ${n(pe, "perdido")}` : ""}`);
  const passados = Object.keys(p.passados_por_corretor ?? {}).length ? ` (${lista(p.passados_por_corretor)})` : "";
  l.push(`• ➡️ Passados para corretor: *${p.passados_corretor}*${passados}`);
  l.push("");

  l.push("*Leads que chegaram*");
  l.push(`• Novos: ${p.recebidos_novos} · Transferidos para ela: ${p.recebidos_transferidos}`);
  if (p.primeiro_contato_feitos || p.primeiro_contato_sem) {
    l.push(`• 1º contato em lead novo: média ${tempo(p.primeiro_contato_media_min)} · ${pct(p.primeiro_contato_ate_1h, p.primeiro_contato_feitos)} em até 1h${p.primeiro_contato_sem ? ` · ${p.primeiro_contato_sem} ainda sem contato` : ""}`);
  }
  l.push("");

  l.push("*Conversões no período*");
  l.push(`• Trabalhados → responderam: ${pct(p.chegaram_atendimento, p.trabalhados)}`);
  l.push(`• Responderam → visita agendada: ${pct(n(pe, "agendamento"), p.chegaram_atendimento)}`);
  l.push(`• Descarte: ${pct(n(pe, "descartado") + n(pe, "perdido"), p.leads_movidos)} dos leads movidos`);
  l.push("");

  // Carteira agora, por funil
  const fases: any[] = c.por_fase ?? [];
  const encerrada = (x: any) => ["descartado", "perdido", "venda"].includes(x.etapa);
  const porFunil = new Map<string, any[]>();
  for (const x of fases.filter((x) => !encerrada(x))) porFunil.set(x.funil, [...(porFunil.get(x.funil) ?? []), x]);
  l.push(`*Carteira agora* (${c.total} leads · ${c.ativos} ativos)`);
  for (const [funil, xs] of porFunil) {
    if (xs.every((x) => x.etapa === "nutricao")) {
      const total = xs.reduce((s, x) => s + x.n, 0), hib = xs.filter((x) => x.fase === "Hibernado").reduce((s, x) => s + x.n, 0);
      l.push(`• ${funil}: ${total}${hib ? ` (Hibernado ${hib} · programados ${total - hib})` : " programados"}`);
    } else {
      l.push(`• ${funil}: ${xs.map((x) => `${curta(x.fase)} ${x.n}`).join(" · ")}`);
    }
  }
  const fim = fases.filter(encerrada);
  if (fim.length) l.push(`• Encerrados: ${fim.map((x) => `${x.fase}${x.funil === "Pré Atendimento" ? " (pré)" : ""} ${x.n}`).join(" · ")}`);
  l.push(`• Já mexeu em ${c.mexidos} de ${c.ativos} ativos (${pct(c.mexidos, c.ativos)})`);
  l.push("");

  const alerta: string[] = [];
  if (c.nao_mexidos) {
    const det = Object.entries(c.nao_mexidos_por_etapa ?? {}).map(([k, v]) => `${ROTULO_ETAPA[k] ?? k} ${v}`).join(" · ");
    alerta.push(`• Nunca mexidos desde que recebeu: *${c.nao_mexidos}* (${det})`);
  }
  if (c.novos_esperando) alerta.push(`• Novos esperando 1º contato: *${c.novos_esperando}* (mais antigo há ${tempo(Number(c.novo_mais_antigo_h) * 60)})`);
  if (c.parados_3d) alerta.push(`• Parados há 3+ dias: ${c.parados_3d}${c.parados_7d ? ` · há 7+ dias: ${c.parados_7d}` : ""}`);
  if (alerta.length) {
    l.push("*⚠️ Atenção*");
    l.push(...alerta);
    l.push("");
  }

  const algoDepois = dep.visitas + dep.propostas + dep.vendas + dep.perdidos;
  if (algoDepois || tipo !== "dia") {
    l.push("*Depois da SDR* (leads que passaram por ela, já com corretor)");
    l.push(`• Visitas: ${dep.visitas} · Propostas: ${dep.propostas} · ✅ Vendas: *${dep.vendas}* · Perdidos: ${dep.perdidos}`);
    l.push("");
  }
  return l.join("\n").trimEnd();
}

async function gerarRelatorio(tipo: TipoRelatorio, opcoes: { teste?: boolean; forcar?: boolean }) {
  const p = periodo(tipo);
  const { data: cfgSdr } = await db.from("crm_vendas_config").select("valor").eq("chave", "sdrs").maybeSingle();
  const ids: string[] = Array.isArray(cfgSdr?.valor) ? cfgSdr.valor : [];
  const { data: sdrs } = ids.length
    ? await db.from("corretores").select("id, nome").in("id", ids).eq("ativo", true).order("nome")
    : { data: [] as any[] };

  const blocos: string[] = [];
  for (const s of sdrs ?? []) {
    const { data, error } = await db.rpc("crm_vendas_sdr_resumo", {
      p_inicio: p.inicio.toISOString(), p_fim: p.fim.toISOString(), p_corretor: s.id,
    });
    if (error) throw error;
    blocos.push(blocoSdr(s.nome, data, tipo));
  }

  const cab = [`*📊 CRM Vendas — Pré-atendimento (SDR)*`, `*${p.titulo}* · _${p.rotulo}_`, ""].join("\n");
  const texto = cab + "\n" + (blocos.length ? blocos.join("\n\n──────────\n\n") : "Nenhum SDR ativo em crm_vendas_config.sdrs.");
  const inicio = new Date(p.inicio.getTime() - FUSO_MS).toISOString().slice(0, 10);

  if (opcoes.teste) return { tipo, inicio, enviado: false, teste: true, texto };

  const { data: ja } = await db.from("crm_vendas_relatorios").select("enviado_em").eq("tipo", tipo).eq("inicio", inicio).maybeSingle();
  if (ja?.enviado_em && !opcoes.forcar) return { tipo, inicio, enviado: false, motivo: "já enviado", texto };

  const c = await config();
  if (!c.instancia || !c.grupo) {
    await db.from("crm_vendas_relatorios").upsert({ tipo, inicio, texto, erro: "grupo ainda não configurado" });
    return { tipo, inicio, enviado: false, motivo: "grupo ainda não configurado (crm_vendas_relatorio_config: instancia e grupo)", texto };
  }

  const r = await evo(`/message/sendText/${encodeURIComponent(c.instancia)}`, {
    method: "POST", body: JSON.stringify({ number: c.grupo, text: texto }),
  });
  await db.from("crm_vendas_relatorios").upsert({
    tipo, inicio, texto, destino: c.grupo,
    enviado_em: r.ok ? new Date().toISOString() : null,
    erro: r.ok ? null : `${r.status} ${JSON.stringify(r.corpo).slice(0, 300)}`,
  });
  return { tipo, inicio, enviado: r.ok, status: r.status, texto };
}

// Grupos de que o número de envio participa (para achar o id do grupo pelo nome).
async function listarGrupos(instanciaParam: string | null) {
  const inst = instanciaParam ?? (await config()).instancia;
  if (!inst) return { erro: "falta a instância (?instancia=NOME ou crm_vendas_relatorio_config.instancia)" };
  const r = await evo(`/group/fetchAllGroups/${encodeURIComponent(inst)}?getParticipants=false`);
  const grupos = Array.isArray(r.corpo) ? r.corpo : [];
  return { instancia: inst, ok: r.ok, grupos: grupos.map((g: any) => ({ id: g.id, nome: g.subject, membros: g.size ?? null })) };
}

// ---------- avisos no WhatsApp do corretor ----------
// A fila crm_vendas_avisos é preenchida por gatilhos no banco: transferência (crm_vendas_movimentos) e recadastro
// (interacoes "Novo cadastro"). O prazo vencido da transferência entra aqui, a partir de crm_vendas_alertas().
// Só envia dentro de avisos_horario (Brasília, ex. "8-21"); fora disso o aviso espera. Aviso com mais de 2 dias é descartado.

const LINK_CRM = "https://marcomartinssm.github.io/crm-vendas-projetar/";

function numeroWhats(tel: string | null | undefined) {
  let d = String(tel ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length >= 12 ? d : null;
}

function dataHora(iso: string | null | undefined) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

async function dadosLead(id: string) {
  const { data: l } = await db.from("leads").select("id, nome, telefone, origem, campanha, codigo_imovel, corretor_id, fase_id, funil_id").eq("id", id).maybeSingle();
  if (!l) return null;
  const [{ data: f }, { data: fu }] = await Promise.all([
    db.from("fases").select("nome").eq("id", l.fase_id).maybeSingle(),
    db.from("funis").select("nome").eq("id", l.funil_id).maybeSingle(),
  ]);
  return { ...l, etapa: [fu?.nome, f?.nome].filter(Boolean).join(" / ") };
}

function fichaLead(l: any) {
  const tel = numeroWhats(l.telefone);
  const linhas = [`*${l.nome || "Sem nome"}*`];
  if (l.telefone) linhas.push(`☏ ${l.telefone}${tel ? ` · wa.me/${tel}` : ""}`);
  linhas.push(`Origem: ${l.origem || "—"}${l.campanha ? ` · ${l.campanha}` : ""}`);
  if (l.codigo_imovel) linhas.push(`Imóvel: Cód. ${l.codigo_imovel}`);
  linhas.push(`Etapa: ${l.etapa || "—"}`);
  return linhas.join("\n");
}

async function montarAviso(a: any, cfg: Record<string, string>, nomes: Record<string, { nome: string; telefone: string | null }>) {
  const l = await dadosLead(a.lead_id);
  if (!l) return null;
  const gestores = String(cfg.avisos_gestores ?? "").split(",").map(numeroWhats).filter(Boolean) as string[];
  const corretor = nomes[a.corretor_id ?? l.corretor_id];
  const telCorretor = numeroWhats(corretor?.telefone);
  const grupo = cfg.grupo || null; // mesmo grupo dos relatórios (id termina em @g.us)
  // Todo aviso vai para o grupo do pré-atendimento (centro das notificações), para o corretor envolvido e para os gestores no privado, se houver.
  const destinos = (tel: string | null) => [...new Set([tel, ...gestores, grupo].filter(Boolean) as string[])];
  const { data: pz } = await db.from("crm_vendas_config").select("valor").eq("chave", "prazo_transferencia_horas").maybeSingle();
  const horas = Number(pz?.valor ?? 2);

  if (a.tipo === "transferencia") {
    const { data: m } = await db.from("crm_vendas_movimentos").select("observacao, extras, quando").eq("id", Number(a.ref)).maybeSingle();
    const { data: ag } = await db.from("crm_vendas_movimentos").select("extras").eq("lead_id", a.lead_id).eq("status_tipo", "agendamento")
      .order("quando", { ascending: false }).limit(1).maybeSingle();
    const de = nomes[m?.extras?.de_corretor]?.nome;
    const t = [`📲 *Lead transferido*`, "", fichaLead(l)];
    if (ag?.extras?.data_visita) t.push(`📅 Visita: ${dataHora(ag.extras.data_visita)}`);
    if (de) t.push(`Passado por: ${de}`);
    if (m?.observacao) t.push(`📝 ${m.observacao}`);
    t.push(`Para: *${corretor?.nome ?? "—"}*`, "", `⏱️ Faça o 1º contato em até ${horas}h e registre no CRM Vendas:`, LINK_CRM);
    return { texto: t.join("\n"), para: destinos(telCorretor) };
  }

  if (a.tipo === "recadastro") {
    const { data: i } = await db.from("interacoes").select("descricao").eq("id", a.ref).maybeSingle();
    const t = [`🔁 *Lead voltou a se cadastrar*`, "", fichaLead(l)];
    if (i?.descricao) t.push(`_${i.descricao}_`);
    t.push(`Com: ${corretor?.nome ?? "—"}`, "", "Chame o cliente e registre o contato no CRM Vendas:", LINK_CRM);
    return { texto: t.join("\n"), para: destinos(telCorretor) };
  }

  // prazo vencido
  const desde = String(a.ref).split("@")[1];
  const h = desde ? Math.floor((Date.now() - new Date(desde).getTime()) / 3600000) : horas;
  const t = [`⚠️ *Prazo vencido — lead transferido sem contato*`, "", fichaLead(l),
    `Com: ${corretor?.nome ?? "—"} · transferido há ${h}h (prazo ${horas}h)`, "", "Registre o contato no CRM Vendas:", LINK_CRM];
  return { texto: t.join("\n"), para: destinos(telCorretor) };
}

async function processarAvisos(opcoes: { teste?: boolean }) {
  const cfg = await config();
  const inst = cfg.avisos_instancia || cfg.instancia;

  // prazo vencido de transferência entra na fila (um aviso por transferência)
  const { data: al } = await db.rpc("crm_vendas_alertas");
  const vencidos = (al ?? []).filter((x: any) => x.tipo === "transferencia" && x.nivel === "vermelho");
  if (vencidos.length && !opcoes.teste) {
    await db.from("crm_vendas_avisos").upsert(
      vencidos.map((x: any) => ({ tipo: "prazo", lead_id: x.lead_id, ref: `${x.lead_id}@${x.referencia}`, corretor_id: x.corretor_id })),
      { onConflict: "tipo,ref", ignoreDuplicates: true },
    );
  }

  const [ini, fim] = String(cfg.avisos_horario ?? "8-21").split("-").map(Number);
  const hora = new Date(Date.now() - FUSO_MS).getUTCHours();
  const noHorario = hora >= ini && hora < fim;

  const limite = new Date(Date.now() - 2 * 86400000).toISOString();
  if (!opcoes.teste) {
    await db.from("crm_vendas_avisos").update({ erro: "expirado (mais de 2 dias na fila)", tentativas: 99 })
      .is("enviado_em", null).lt("criado_em", limite).lt("tentativas", 3);
  }
  const { data: fila } = await db.from("crm_vendas_avisos").select("*").is("enviado_em", null).lt("tentativas", 3)
    .gte("criado_em", limite).order("criado_em").limit(30);
  if (!fila?.length) return { pendentes: 0, no_horario: noHorario };
  if (!noHorario && !opcoes.teste) return { pendentes: fila.length, no_horario: false, motivo: "fora do horário de avisos" };
  if (!inst && !opcoes.teste) return { erro: "falta a instância (crm_vendas_relatorio_config.instancia)" };

  const { data: cs } = await db.from("corretores").select("id, nome, telefone");
  const nomes = Object.fromEntries((cs ?? []).map((c: any) => [c.id, { nome: c.nome, telefone: c.telefone }]));

  const feitos = [];
  for (const a of fila) {
    const msg = await montarAviso(a, cfg, nomes);
    if (opcoes.teste) { feitos.push({ id: a.id, tipo: a.tipo, para: msg?.para, texto: msg?.texto }); continue; }
    if (!msg || !msg.para.length) {
      await db.from("crm_vendas_avisos").update({ tentativas: 99, erro: msg ? "sem telefone de destino" : "lead não encontrado" }).eq("id", a.id);
      continue;
    }
    const erros: string[] = [];
    for (const numero of msg.para) {
      const r = await evo(`/message/sendText/${encodeURIComponent(inst)}`, { method: "POST", body: JSON.stringify({ number: numero, text: msg.texto }) });
      if (!r.ok) erros.push(`${numero}: ${r.status} ${JSON.stringify(r.corpo).slice(0, 150)}`);
    }
    const ok = erros.length < msg.para.length;
    await db.from("crm_vendas_avisos").update({
      enviado_em: ok ? new Date().toISOString() : null, tentativas: a.tentativas + 1,
      erro: erros.length ? erros.join(" | ") : null, destinos: msg.para.join(","),
    }).eq("id", a.id);
    feitos.push({ id: a.id, tipo: a.tipo, ok });
  }
  return { processados: feitos.length, feitos };
}

// ---------- servidor ----------

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token || token !== (await config()).token) return responder({ erro: "token inválido" }, 401);

  try {
    const acao = url.searchParams.get("acao");
    if (acao === "relatorio") {
      const tipo = url.searchParams.get("tipo") as TipoRelatorio;
      if (!["dia", "semana", "mes"].includes(tipo)) return responder({ erro: "tipo deve ser dia, semana ou mes" }, 400);
      const teste = url.searchParams.get("teste") === "1";
      if (!teste && !EVOLUTION_API_KEY) return responder({ erro: "Falta o segredo EVOLUTION_API_KEY no Supabase." }, 500);
      return responder(await gerarRelatorio(tipo, { teste, forcar: url.searchParams.get("forcar") === "1" }));
    }
    if (acao === "grupos") return responder(await listarGrupos(url.searchParams.get("instancia")));
    if (acao === "avisos") {
      const teste = url.searchParams.get("teste") === "1";
      if (!teste && !EVOLUTION_API_KEY) return responder({ erro: "Falta o segredo EVOLUTION_API_KEY no Supabase." }, 500);
      return responder(await processarAvisos({ teste }));
    }
    return responder({ erro: "acao deve ser relatorio, grupos ou avisos" }, 400);
  } catch (e) {
    console.error(e);
    return responder({ erro: String((e as Error)?.message ?? e) }, 500);
  }
});
