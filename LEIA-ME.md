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
- Lead criado para corretor inativo vai para a SDR ativa (gatilho `lead_sem_corretor_inativo` → `crm_lead_sem_corretor_inativo`; antes ia para a Pamela).
- SDR atual (22/10/2026): Carolini Labes. Recebeu todos os leads da Pamela e os Hibernados de Meta Ads da Projetar Imóveis (58, registrados em `crm_vendas_movimentos` como `transferencia`).

## Histórico dos leads
- `crm_vendas_leads_historico` — gatilho `zz_crm_vendas_historico_lead` em `leads` grava toda criação e toda mudança de fase/funil/corretor, venha de onde vier (CRM Leads, CRM Vendas, automações), com `por` = usuário logado. O CRM Leads não guardava isso.
- Linhas com `origem = 'reconstruido'`: o que a Carol fez em 22–23/10, antes do gatilho existir (só a última mudança de cada lead).

## Relatórios da SDR no WhatsApp (mesmo modelo do CRM Aluguel)
- Números: `crm_vendas_sdr_resumo(inicio, fim, corretor)` (só service_role). "Mexer" no lead = interação registrada (`interacoes`, menos "Novo cadastro"), mudança de etapa feita por ela ou movimento no CRM Vendas.
- Mostra: leads trabalhados, contatos por tipo, mudanças de etapa e avanços, respostas (chegaram em Em atendimento), visitas agendadas, nutrição, descartes, passados para corretor, leads novos e tempo até o 1º contato, conversões, carteira agora por fase, nunca mexidos, novos esperando, parados 3+/7+ dias e o que aconteceu depois com os leads que passaram por ela.
- Edge function `crm-vendas-relatorio` (código em `supabase/functions/crm-vendas-relatorio/index.ts`, verify_jwt desligado, protegida por `?token=`). Token, instância e grupo em `crm_vendas_relatorio_config` (tabela só do servidor; o token também em `.token` nesta pasta, fora do git).
- Testar sem enviar: `POST .../functions/v1/crm-vendas-relatorio?token=...&acao=relatorio&tipo=dia&teste=1`. Reenviar: `&forcar=1`. Grupos do número: `GET ...&acao=grupos&instancia=Seguralta`.
- Envia pela instância Seguralta para o grupo **Pré-atendimento Projetar** (id em `crm_vendas_relatorio_config.grupo`). O número precisa estar no grupo.
- **Diário:** seg–sex 18h30 (o dia de hoje). **Semanal:** sábado 9h (sábado a sexta). **Mensal:** dia 1 às 8h05 (mês anterior). pg_cron `crm-vendas-relatorio-*` → `crm_vendas_chamar_relatorio(tipo)`.
- Cada envio fica em `crm_vendas_relatorios` (não manda duas vezes o mesmo período).

## Entrada (aba "Entrada", só SDR e gestor) — igual à Entrada do CRM Aluguel
- `crm_vendas_entrada`: contatos do WhatsApp que ainda não viraram lead. Duas fontes:
  1. **Contatos marcados "Vendas" na Entrada do CRM Aluguel** (Milene/central e Thainara/ALUGUELARA) — gatilho `zz_crm_vendas_entrada_do_aluguel` em `crm_aluguel_contatos`. Em 27/10/2026 entraram os 9 dos últimos 30 dias.
  2. **Número de vendas na Evolution**: edge function `crm-vendas-entrada` (código em `supabase/functions/crm-vendas-entrada/index.ts`, verify_jwt desligado, `?token=` = o mesmo dos relatórios). Só atende instâncias listadas em `crm_vendas_relatorio_config.entrada_instancias` = **venda-ara** (o único número de vendas, decisão do Marco em 27/10/2026). Ligar: incluir o nome lá e `POST ...crm-vendas-entrada?token=...&acao=ligar_webhook&instancia=NOME` (ver antes `acao=webhook_atual` — a Evolution aceita **um** webhook por número). `acao=instancias` lista os números e para onde mandam hoje.
- Regras: grupos e números da casa (donos das instâncias e corretores) são ignorados; mesmo telefone já na Entrada (aberto ou com conversa nos últimos 120 dias) só atualiza a última mensagem; mede a 1ª resposta (minutos corridos).
- Botões: **Vendas** abre a janela "Mídia de origem" (WhatsApp, Meta Ads, Placa, Site, Instagram…) e cria o lead em "Novo Lead" do pré-atendimento (vai para a SDR), campanha "Entrada WhatsApp". Se o telefone já é lead, não duplica: grava "Novo cadastro" no lead existente (selo "Voltou a se cadastrar" + aviso no grupo). **Outros** só tira da Entrada. Função `crm_vendas_entrada_classificar`.
- O histórico do lead mostra "Chegou pela Entrada" com a mídia de origem e a primeira mensagem.

## Fila do dia (aba "Fila do dia")
- O que fazer hoje, por funil e em ordem de urgência: 🔁 voltaram a se cadastrar (últimos 30 dias, sem contato depois) → 🆕 novos do pré (mais recentes primeiro) → 📞 retornos do pré (1º ao 5º contato; atrasados e depois o contato mais antigo) → 🤝 em atendimento no funil de vendas (atrasados primeiro) → 💤 nutrição com retorno vencido.
- Quem tem contato registrado hoje sai da fila (menos quem tem aviso de atraso). Tudo calculado na tela (`telaFila` em `index.html`).
- Prazos por tentativa de contato e rapidez com lead novo: ficam para depois (decisão do Marco, 26/10/2026).

## Nutrição (aba "Nutrição")
- Funil "Nutrição" do CRM Leads (Hibernado, 15 dias … 360 dias). O retorno vence N dias depois que o lead entrou na coluna (`fase_atualizada_em`); Hibernado não tem data.
- Status `origem = 'nutricao'` em `crm_vendas_status`: "Retornar em N dias" (um por coluna). Aparecem para leads do pré, da nutrição, da SDR e para o gestor.
- `crm_vendas_mover_lead`: lead na nutrição usa os status do pré e da nutrição (não os de venda). Saindo da nutrição, a tentativa de contato volta para o "1º contato".

## Avisos no WhatsApp (o grupo é o centro de todas as notificações)
- **Todo aviso vai para o grupo Pré-atendimento Projetar** e também para o corretor envolvido (privado). Corretor sem telefone: só o grupo.
- Fila `crm_vendas_avisos`, preenchida por gatilhos: **transferência** (`crm_vendas_movimentos` tipo `transferencia`: dados do lead, visita, recado e para quem foi) e **recadastro** (`interacoes` "Novo cadastro").
- Sem aviso: lead passado para a SDR; troca de corretor direto em `leads` (não gera movimento); e lote feito por SQL com `select set_config('crm_vendas.sem_aviso', '1', true);` antes dos inserts (padrão quando o Claude faz transferência a pedido, salvo se pedirem o aviso).
- Gestores no privado (`avisos_gestores`, telefones separados por vírgula): vazio desde 26/10 — o Marco acompanha pelo grupo.
- **Visita agendada:** todo movimento de agendamento (data obrigatória) gera aviso no grupo e ao corretor do lead, com data, imóvel, quem agendou e o resumo (gatilho `zz_crm_vendas_aviso_visita`).
- **Prazo da transferência:** `crm_vendas_config.prazo_transferencia_horas` (2). Em `crm_vendas_alertas()` o tipo `transferencia` fica amarelo até o prazo e vermelho depois (não vale para transferência para a SDR). Vencido → aviso ao corretor e ao grupo.
- Envio: edge function `crm-vendas-relatorio?acao=avisos` (pg_cron `crm-vendas-avisos`, a cada 2 min), pela instância Seguralta, só dentro de `avisos_horario` (8-21, Brasília); fora disso espera. Aviso com mais de 2 dias na fila é descartado. Ver sem enviar: `&teste=1`.
- "Novo cadastro" não conta mais como contato (nem no cartão, nem nos avisos de atraso).

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

- **De onde vêm os leads** (`crm_vendas_painel_origens`): leads que entraram no período, por origem, e até onde cada um já chegou (contatado, respondeu, agendou, visitou, proposta, venda, descartado/perdido), mais a Entrada do WhatsApp no período.
- **Onde o funil trava**: leads em cada etapa agora, tempo médio na etapa, parados 7+ dias e tempo médio para sair (do histórico, desde 22/10/2026).

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
