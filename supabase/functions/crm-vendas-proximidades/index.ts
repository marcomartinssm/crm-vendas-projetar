// CRM Vendas: o que tem perto do imóvel, pelo Google Maps (Places API New).
// A ficha manda o endereço; a função acha o ponto no mapa (1 busca de texto) e procura os lugares mais próximos
// de cada categoria (12 buscas "perto de"; posto de saúde é por texto). O corretor confere tudo na ficha antes de enviar ao gestor.
//
// POST { endereco: { rua, numero, bairro, cidade, uf, cep }, token? }
//   - corretor logado: manda o login (Authorization: Bearer <jwt>) e precisa participar do CRM Vendas
//   - link do celular: manda o token da sessão (crm_vendas_link_sessoes, válida por 12 horas)
// Limite: 150 buscas por dia (crm_vendas_google_reservar), para ficar dentro das 5 mil grátis por mês.
// Segredo usado: GOOGLE_MAPS_KEY (nunca vai para a tela).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
const CHAVE = (Deno.env.get("GOOGLE_MAPS_KEY") ?? "").trim();

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info" };
const responder = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// Categorias buscadas pela atividade principal do lugar (includedPrimaryTypes), para não vir cafeteria como mercado.
// As escolas vêm numa busca só e são separadas pelo nome (o Google não diz se é pública); centros de educação infantil vão para creche.
// "texto": busca por texto perto do imóvel, para o que o Google não tem tipo próprio (posto de saúde / UBS).
const CATEGORIAS: { k: string; tipos?: string[]; texto?: string; max?: number }[] = [
  { k: "mercado", tipos: ["supermarket", "grocery_store"] },
  { k: "farmacia", tipos: ["pharmacy", "drugstore"] },
  { k: "posto", tipos: ["gas_station"] },
  { k: "padaria", tipos: ["bakery"] },
  { k: "banco", tipos: ["bank"] },
  { k: "escola", tipos: ["school", "primary_school", "secondary_school"], max: 20 },
  { k: "creche", tipos: ["preschool"] },
  { k: "saude", texto: "posto de saúde UBS ESF", max: 10 },
  { k: "hospital", tipos: ["hospital"] },
  { k: "praca", tipos: ["park"] },
  { k: "academia", tipos: ["gym", "fitness_center"] },
  { k: "igreja", tipos: ["church"] },
];
const BUSCAS = CATEGORIAS.length + 1;
const RAIO = 3000; // metros
const PUBLICA = /municipal|estadual|federal|\bE\.?\s?E\.?\s?B\b|\bEEB\b|\bEMEF\b|\bEMEB\b|\bIFSC\b|\bUFSC\b|escola b[aá]sica|grupo escolar/i;
const INFANTIL = /\bCEI\b|\bNEI\b|\bCMEI\b|\bEMEI\b|educa[cç][aã]o infantil|creche|maternal|ber[cç][aá]rio/i;
// Saúde: posto de saúde, UBS e hospital vêm primeiro; consultório de especialidade fica de fora.
const SAUDE_BOA = /hospital|\bUBS\b|\bESF\b|\bUPA\b|unidade b[aá]sica|posto de sa[uú]de|pronto.?socorro|pronto.?atendimento|policl[ií]nica|unidade de sa[uú]de|centro de sa[uú]de/i;
const SAUDE_FORA = /fisio|odonto|dent|psic|nutri|est[eé]tic|fono|pilates|podo|terapia|veterin/i;
const SO_ENDERECO = /^(rua|r\.|av\.?|avenida|rod\.?|rodovia|travessa)\s/i; // lugar sem nome, só o endereço

function metros(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * r * Math.asin(Math.sqrt(h)));
}

async function google(caminho: string, campos: string, corpo: unknown) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://places.googleapis.com/v1/${caminho}`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": CHAVE, "X-Goog-FieldMask": campos },
      body: JSON.stringify(corpo),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.error?.message || `Google respondeu ${res.status}`);
    return d;
  } finally { clearTimeout(t); }
}

async function autorizado(req: Request, token?: string) {
  if (token) {
    const { data } = await db.from("crm_vendas_link_sessoes").select("token").eq("token", token).gt("expira_em", new Date().toISOString()).maybeSingle();
    return !!data;
  }
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const usuario = createClient(SUPABASE_URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: u } = await usuario.auth.getUser(jwt);
  if (!u?.user) return false;
  const { data: participa } = await usuario.rpc("crm_vendas_participa");
  return !!participa;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return responder({ erro: "Use POST." }, 405);
  if (!CHAVE) return responder({ erro: "Chave do Google não configurada." }, 500);

  let corpo: { endereco?: Record<string, string>; token?: string };
  try { corpo = await req.json(); } catch { return responder({ erro: "Pedido inválido." }, 400); }
  if (!(await autorizado(req, corpo.token))) return responder({ erro: "Entre no CRM de novo para buscar." }, 401);

  const e = corpo.endereco ?? {};
  if (!e.rua || !e.cidade) return responder({ erro: "Preencha rua e cidade na primeira etapa." }, 400);

  const { data: ok, error } = await db.rpc("crm_vendas_google_reservar", { p_n: BUSCAS });
  if (error) return responder({ erro: "Não foi possível buscar agora. Tente de novo." }, 500);
  if (!ok) return responder({ erro: "O limite de buscas de hoje acabou. Tente amanhã ou preencha à mão." }, 429);

  try {
    // 1) Ponto do imóvel no mapa
    const texto = `${e.rua}${e.numero ? ", " + e.numero : ""}${e.bairro ? " - " + e.bairro : ""}, ${e.cidade}${e.uf ? " - " + e.uf : ""}${e.cep ? ", " + e.cep : ""}, Brasil`;
    const g = await google("places:searchText", "places.location,places.formattedAddress",
      { textQuery: texto, languageCode: "pt-BR", regionCode: "BR", pageSize: 1 });
    const p = g.places?.[0];
    if (!p?.location) return responder({ erro: "O Google não achou esse endereço. Confira rua, número e cidade." }, 404);
    const centro = { lat: p.location.latitude, lng: p.location.longitude };

    // 2) Lugares perto, do mais próximo para o mais longe; fechados de vez ficam de fora
    // Uma categoria com problema não derruba as outras: ela volta vazia e o corretor preenche à mão.
    const falhas: string[] = [];
    const res = await Promise.all(CATEGORIAS.map(async (c) => {
      const campos = "places.id,places.displayName,places.location,places.businessStatus";
      const circulo = { circle: { center: { latitude: centro.lat, longitude: centro.lng }, radius: RAIO } };
      const d = await (c.texto
        ? google("places:searchText", campos, { textQuery: c.texto, pageSize: c.max ?? 6, rankPreference: "DISTANCE", languageCode: "pt-BR", regionCode: "BR", locationBias: circulo })
        : google("places:searchNearby", campos, { includedPrimaryTypes: c.tipos, maxResultCount: c.max ?? 6, rankPreference: "DISTANCE", languageCode: "pt-BR", regionCode: "BR", locationRestriction: circulo })
      ).catch((err) => { falhas.push(`${c.k}: ${err.message}`); return { places: [] }; });
      const lista = (d.places ?? [])
        .filter((x: any) => x.businessStatus !== "CLOSED_PERMANENTLY" && x.displayName?.text && !SO_ENDERECO.test(x.displayName.text))
        .map((x: any) => ({ id: x.id, nome: x.displayName.text, m: metros(centro, { lat: x.location.latitude, lng: x.location.longitude }) }))
        .filter((x: any) => x.m <= RAIO * 1.5); // a busca por texto só "puxa" para perto; corta o que ficou longe
      return [c.k, lista] as const;
    }));
    const cats: Record<string, { id: string; nome: string; m: number }[]> = {};
    for (const [k, lista] of res) {
      if (k === "escola") {
        const escolas = lista.filter((x) => !INFANTIL.test(x.nome));
        cats.escola_pub = escolas.filter((x) => PUBLICA.test(x.nome)).slice(0, 3);
        cats.escola_part = escolas.filter((x) => !PUBLICA.test(x.nome)).slice(0, 3);
        cats.creche_escolas = lista.filter((x) => INFANTIL.test(x.nome));
      } else cats[k] = lista;
    }
    // Creche: o que o Google chama de pré-escola + centros de educação infantil achados na busca de escolas
    const vistos = new Set<string>();
    cats.creche = [...(cats.creche ?? []), ...(cats.creche_escolas ?? [])]
      .filter((x) => !vistos.has(x.id) && vistos.add(x.id)).sort((a, b) => a.m - b.m);
    delete cats.creche_escolas;
    // Saúde: posto de saúde (texto) + hospital, do mais perto para o mais longe; consultório de especialidade fica de fora
    const saude = [...(cats.saude ?? []), ...(cats.hospital ?? [])].filter((x) => !SAUDE_FORA.test(x.nome));
    const vs = new Set<string>();
    cats.saude = saude.filter((x) => !vs.has(x.id) && vs.add(x.id)).sort((a, b) => (SAUDE_BOA.test(b.nome) ? 1 : 0) - (SAUDE_BOA.test(a.nome) ? 1 : 0) || a.m - b.m);
    delete cats.hospital;
    for (const k of Object.keys(cats)) cats[k] = cats[k].slice(0, 3);
    return responder({ ok: true, endereco_google: p.formattedAddress, lat: centro.lat, lng: centro.lng, cats, falhas, quando: new Date().toISOString() });
  } catch (err) {
    return responder({ erro: "O Google não respondeu. Tente de novo.", detalhe: String((err as Error).message ?? err) }, 502);
  }
});
