# CRM Vendas — Projetar Imóveis

Regras do processo e da gamificação: documento "Processo de Vendas e Gamificação da Projetar Imóveis" (Claude Docs).

## Arquivos
- `index.html` — sistema de verdade (login do CRM Leads + Supabase). Aba Imóveis: cadastro em 7 etapas, nota do imóvel, aprovação do Marco.
- `demo.html` — versão de demonstração antiga (dados só no navegador). Não usar para cadastro real.
- Testar no Mac: launch.json `crm-vendas` → http://localhost:8897 (link direto de cadastro: `#novo`).

## Banco (Supabase jgdbnkwhmesgjvsymgma), tudo com prefixo `crm_vendas_`
- `crm_vendas_imoveis` — um imóvel por linha. `codigo` sequencial a partir de 1001 (criado sozinho), `codigo_imoview`, `status` (rascunho / aguardando / devolvido / ativo), `dados` (jsonb com todo o formulário), `nota`, `atualizado_em` (última atualização com o proprietário).
- `crm_vendas_imoveis_historico` — envio, aprovação, devolução, atualização.
- `crm_vendas_config` — `aprovadores` (user id do Marco) e `participantes` (ids de corretores do piloto: Fernando e Leonardo). Para liberar outro corretor, incluir o id dele em `participantes`.
- Funções: `crm_vendas_aprovar`, `crm_vendas_devolver`, `crm_vendas_registrar_atualizacao` (só por elas o imóvel vira ativo / devolvido / atualizado; um gatilho protege esses campos).
- Arquivos: bucket privado `crm-vendas`, pasta `<user id>/<imóvel id>/...`. O corretor vê os dele, o Marco vê todos.
- Login: o mesmo do CRM Leads (`usuarios_corretores` liga o usuário ao corretor).

## Funil de vendas (aba "Funil de vendas", tela inicial)
- É o funil "Atendimento" do CRM Leads (tabelas `funis`/`fases`/`leads`). Em 15/10/2026: "Atendimento" virou "Em atendimento", "Visita" virou "Visita realizada", "Agendamento de Visita" virou "Agendamento de visita"; criadas "Novo lead", "Não compareceu", "Perdido", "Descartado". Ids antigos mantidos. Mapa das fases em `crm_vendas_config.funil_vendas`.
- `crm_vendas_status` — status de cada coluna (o que se escolhe ao mover; `tipo` guia regras: agendamento, visita, noshow_cliente, noshow_corretor, proposta, venda, perdido, descartado).
- `crm_vendas_movimentos` — cada passagem: de/para, status, observação obrigatória, extras (data da visita, valor, honorário, tipo de venda...), corretor, quem, quando.
- Funções: `crm_vendas_mover_lead` (valida permissão, observação e campos obrigatórios por tipo) e `crm_vendas_novo_lead` (lead de prospecção entra em "Novo lead").
- Leads seguem a regra de acesso do CRM Leads: corretor vê os dele, admin vê todos.

## Pré-atendimento (SDR) e transferência
- Aba "Pré-atendimento" = funil "Pré Atendimento" do CRM Leads (`crm_vendas_config.funil_pre`). `crm_vendas_status.origem` diz em que funil cada status aparece (vendas / pre / ambos).
- `crm_vendas_config.sdrs` = ids de corretores que são SDR (vazio até contratar). Botão "Transferir atendimento" aparece para leads de SDR em "Em atendimento" ou "Agendamento de visita" (e para o gestor). Função `crm_vendas_transferir`; sugestão do agenciador: `crm_vendas_sugerir_corretor`.
- Ao contratar o SDR: cadastrar como corretor + login (usuarios_corretores), incluir o id em `sdrs` e em `participantes`.

## Atividades (aba "Atividades")
- `crm_vendas_atividades` — visita de prospecção e visita a imóvel na planta (foto + check-in GPS + descrição), post no Instagram (link + vídeo/estático), avaliação no Google (link + cliente), contato de pós-venda.
- `crm_vendas_reunioes` — presença na reunião semanal (só o Marco marca).
- Funções: `crm_vendas_metas_semana` (todas as metas da semana de um corretor), `crm_vendas_pos_venda` (lembretes 30/90 dias), `crm_vendas_base_antiga` (clientes sem contato há 90+ dias, para reativação), `crm_vendas_corretores_game` (quem pontua: participantes que não são SDR).
- Avisos de prazo: `crm_vendas_alertas()`; foto diária dos atrasos em `crm_vendas_atrasos_diarios` (pg_cron 18h).
- O SDR não tem pontuação.

## Pontuação (aba "Pontuação")
- `crm_vendas_ranking()` monta o ranking do semestre de calendário (jan–jun, jul–dez; 2º sem/2026 = teste, oficial a partir de 01/01/2027) chamando `crm_vendas_pontos_corretor(c)` para cada corretor do game. Tudo é calculado na hora a partir do funil, imóveis, atividades e das fotos diárias (`crm_vendas_atrasos_diarios`, `crm_vendas_carteira_diaria`, gravadas pelo pg_cron às 18h).
- Regras: pontos só valem após a 1ª venda do semestre; agenciamento no máximo 42% do total; +50 a cada 4 semanas seguidas com todas as metas; total nunca negativo.

## Comissão (aba "Comissão", game trimestral)
- `crm_vendas_trimestre(ano, tri)`: categoria do trimestre e apurada, vendas e VGV, comissão de cada venda (no ato, final, diferença), recebimentos como agenciador e time Platina.
- 4º trimestre de 2026 é teste; em 01/01/2027 todos recomeçam em Ferro.
- Venda dividida exige o parceiro (`extras.parceiro`); cada um conta 1 venda e 50% do VGV e do honorário.
- Times da Platina: `crm_vendas_config.times` = {"<id do líder>": ["<id membro>", ...]} (ainda vazio).

## Painel (aba "Painel", só o gestor) e "Ver como"
- `crm_vendas_painel(ini, fim)`: movimento do período, taxas, atrasos, visão por corretor, funil agora, perdas e imóveis.
- Seletor "Ver como" no topo: o gestor vê o sistema filtrado como um corretor vê (só visualização; ações ficam no nome do gestor).

## Posse no 61º dia
- `crm_vendas_posse_pedidos` + cron horário `crm_vendas_pedidos_posse`: imóvel ativo com 61+ dias sem atualização abre pedido para o gestor (aba Aprovação e aviso no Painel). `crm_vendas_decidir_posse(pedido, 'transferir'|'manter', novo_corretor, obs)`.

## Descrição com IA
- Edge function `crm-vendas-descricao` (código em `supabase/functions/crm-vendas-descricao/index.ts`), modelo claude-opus-5-5, saída estruturada. Precisa do secret `ANTHROPIC_API_KEY` no Supabase (Edge Functions → Secrets). Sem a chave, o botão avisa que a IA ainda não está ligada.

## Endereço publicado
- https://marcomartinssm.github.io/crm-vendas-projetar/ (link direto de cadastro de imóvel: `.../#novo`)
- Repositório público `marcomartinssm/crm-vendas-projetar` (GitHub Pages, branch main, raiz). Para atualizar: commit + push na main; o site atualiza em ~1 minuto.
- O CRM Leads continua separado (`crmleads-projetar`), como segurança.

## Abrir no Mac
```
python3 -m http.server 8897 --directory "/Users/marcomartins/Documents/IA e automações/Claude/CRM Vendas - CC"
```
Depois abrir http://localhost:8897 (entrar com o login do CRM Leads).

## Ainda não feito
- Cadastrar a chave da API da Anthropic (secret ANTHROPIC_API_KEY).
- Endereço final: decidir junto com o CRM Leads.
- Time Platina em stand-by.
