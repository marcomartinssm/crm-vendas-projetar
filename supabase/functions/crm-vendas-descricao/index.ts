// Gera a descrição do anúncio (com SEO) a partir das respostas do formulário de cadastro do imóvel.
// Chamada pela tela do CRM Vendas com o login do usuário. Precisa do secret ANTHROPIC_API_KEY no Supabase.
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Formato fixo da resposta (saída estruturada).
const SCHEMA = {
  type: "object",
  properties: {
    palavra_chave: { type: "string", description: "Palavra-chave principal, ex.: casa à venda no Centro de Araranguá" },
    long_tails: { type: "array", items: { type: "string" }, description: "3 a 5 variações de cauda longa" },
    titulo_google: { type: "string", description: "Título para o Google, no máximo 60 caracteres" },
    meta_description: { type: "string", description: "Meta description, no máximo 155 caracteres" },
    h1: { type: "string" },
    secoes: {
      type: "array",
      description: "Corpo do anúncio em 2 a 4 seções, somando 150 a 200 palavras",
      items: {
        type: "object",
        properties: { h2: { type: "string" }, texto: { type: "string" } },
        required: ["h2", "texto"],
        additionalProperties: false,
      },
    },
  },
  required: ["palavra_chave", "long_tails", "titulo_google", "meta_description", "h1", "secoes"],
  additionalProperties: false,
};

const SISTEMA = `Você escreve anúncios de imóveis à venda para o site da Projetar Imóveis (Araranguá, SC).
Escreva em português do Brasil, tom profissional e acolhedor, sem exageros e sem inventar nada:
use só as informações recebidas. Pense em SEO local: a palavra-chave principal combina tipo de imóvel,
"à venda", bairro e cidade, e aparece no título, no H1 e no primeiro parágrafo. O título do Google tem
no máximo 60 caracteres; a meta description, no máximo 155 e termina com um convite para agendar visita.
O corpo soma de 150 a 200 palavras, dividido em seções com H2 (por exemplo: o imóvel, a localização,
condições). Não cite valores de IPTU ou condomínio no texto. Não use emojis.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Use POST." }, 405);

  // Só quem tem acesso ao CRM Vendas pode gerar.
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: participa } = await sb.rpc("crm_vendas_participa");
  if (!participa) return json({ erro: "Sem acesso ao CRM Vendas." }, 403);

  const chave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!chave) return json({ erro: "A geração com IA ainda não está ligada: falta cadastrar a chave da API." }, 503);

  let dados: Record<string, unknown>;
  try {
    ({ dados } = await req.json());
    if (!dados || typeof dados !== "object") throw new Error();
  } catch {
    return json({ erro: "Dados do imóvel não enviados." }, 400);
  }

  const client = new Anthropic({ apiKey: chave });
  try {
    const resposta = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SISTEMA,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content: `Dados do imóvel (respostas do corretor):\n${JSON.stringify(dados, null, 2)}` }],
    });
    if (resposta.stop_reason === "refusal") return json({ erro: "A IA não conseguiu gerar este texto. Tente ajustar as respostas." }, 422);
    if (resposta.stop_reason === "max_tokens") return json({ erro: "A resposta ficou incompleta. Tente de novo." }, 502);
    const texto = resposta.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return json({ descricao: JSON.parse(texto), modelo: resposta.model });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ erro: "A chave da API cadastrada não é válida." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ erro: "Muitos pedidos agora. Tente em um minuto." }, 429);
    if (e instanceof Anthropic.APIError) return json({ erro: `Erro da IA (${e.status}). Tente de novo.` }, 502);
    return json({ erro: "Não foi possível gerar a descrição." }, 500);
  }
});
