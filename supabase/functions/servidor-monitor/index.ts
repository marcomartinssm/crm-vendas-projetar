// Aviso de queda do servidor: o vigia do GitHub (.github/workflows/servidor-monitor.yml) testa o Supabase a cada
// 5 minutos e chama esta função quando o servidor cai ou volta. Ela não usa o banco (que pode estar fora do ar):
// só confere o token, testa o servidor de novo e manda a mensagem no grupo pela Evolution.
//
// POST { token, destino: "instancia|grupo", evento: "caiu" | "voltou", desde?: ISO }
// token e destino ficam nos segredos do GitHub (MONITOR_TOKEN, MONITOR_DESTINO); aqui só os hashes, porque o repositório é público.
// Segredo usado (já existe no projeto): EVOLUTION_API_KEY

const EVOLUTION_URL = Deno.env.get("EVOLUTION_URL") ?? "https://dinastia-evolution.saxddq.easypanel.host";
const EVOLUTION_API_KEY = Deno.env.get("EVOLUTION_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const HASH_TOKEN = "90932fbb018e28485c914e099068c7dc8fd968425473e0c34be0cbbe2df6ff6a";
const HASH_DESTINO = "e042d155ea2dd128b527d89bd6f9133149575bb175b24ecb5cdcb161a457b79e";

const responder = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Mesmo teste do vigia: uma consulta simples que passa pela API e pelo banco.
async function servidorNoAr() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/fases?select=id&limit=1`, { headers: { apikey: ANON }, signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

const hora = (d: Date) => d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

function duracao(desde: string | undefined) {
  const ms = desde ? Date.now() - new Date(desde).getTime() : NaN;
  if (!(ms > 0)) return "";
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return responder({ erro: "use POST" }, 405);
  const b = await req.json().catch(() => ({}));
  if (!b.token || (await sha256(String(b.token))) !== HASH_TOKEN) return responder({ erro: "token inválido" }, 401);
  if (!b.destino || (await sha256(String(b.destino))) !== HASH_DESTINO) return responder({ erro: "destino inválido" }, 400);
  const [instancia, grupo] = String(b.destino).split("|");

  const noAr = await servidorNoAr();
  let texto: string;
  if (b.evento === "caiu") {
    if (noAr) return responder({ ignorado: "servidor respondeu agora" });
    texto = `⚠️ *Servidor fora do ar*\n\nO servidor do Supabase não responde desde ${b.desde ? hora(new Date(b.desde)) : "agora"}. ` +
      `CRM Vendas, CRM Leads e CRM Aluguel podem não abrir.\n\n` +
      `Para resolver: supabase.com/dashboard → projeto → Project Settings → General → *Restart project* (leva uns 5 min).`;
  } else if (b.evento === "voltou") {
    if (!noAr) return responder({ ignorado: "servidor ainda fora" });
    const d = duracao(b.desde);
    texto = `✅ *Servidor de volta*\n\nO Supabase voltou a responder às ${hora(new Date())}${d ? ` (ficou fora ${d})` : ""}. Os sistemas já podem ser usados.`;
  } else {
    return responder({ no_ar: noAr });
  }

  const r = await fetch(`${EVOLUTION_URL}/message/sendText/${encodeURIComponent(instancia)}`, {
    method: "POST",
    headers: { apikey: EVOLUTION_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ number: grupo, text: texto }),
  });
  return responder({ enviado: r.ok, status: r.status }, r.ok ? 200 : 502);
});
