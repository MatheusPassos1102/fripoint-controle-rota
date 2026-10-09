# 01 — Análise do POP-LOG-001 v1.1 como referência operacional

Documento analisado: **POP-LOG-001 — Gestão de rota, conferência de entregas e orientação contínua**,
versão 1.1 (minuta para aprovação; substitui a 1.0 somente após aprovação). Referência original: v1.0 emitida em 27/07/2026.

Esta análise extrai do POP tudo o que vira regra de software, aponta o que o POP deixa em aberto e
registra as decisões de projeto tomadas para cada lacuna. Tudo o que depende de decisão da Fripoint
está consolidado em `03-pontos-de-aprovacao.md`.

## 1. Princípios que governam o sistema

| # | Princípio do POP | Consequência de projeto |
|---|---|---|
| P1 | **Regra de ouro (seção 1):** entrega só é documentalmente conforme quando todas as evidências aplicáveis foram recebidas, legíveis e vinculadas ao cliente certo, na sequência prevista. | A conclusão sobre a rota é calculada por software a partir de um checklist determinístico (`src/domain/route-state.ts`), nunca pela IA. |
| P2 | Mensagem isolada não comprova entrega; registro faltante permanece **pendente** ou **não conforme** conforme a regra de avaliação. | Estado padrão de item ausente é PENDENTE; vira NÃO CONFORME apenas após "marco definido" (parâmetro gerencial, ainda não definido). |
| P3 | A IA **auxilia** a supervisão; não substitui verificação humana nem a obrigação do motorista (seção 5). | Toda saída da IA é observação com referência à mensagem/foto de origem; decisão final é humana. |
| P4 | Jamais tratar evidência não recebida como fraude, nem foto duvidosa como comprovação (5.2). | Suspeita de reaproveitamento gera "averiguação humana"; nunca há rótulo de fraude. |
| P5 | O POP **não define tolerância numérica** de pesagem; nenhum limite automático deve ser inventado (5.3). | Toda diferença etiqueta × balança é sinalizada. Tolerância só existe se a gestão parametrizar. |
| P6 | Mensagens ambíguas nunca devem ser associadas automaticamente ao cliente errado (Anexo A). | Parser determinístico; caso ambíguo vai para IA com exigência de código **escrito** na mensagem e, ainda assim, para revisão humana. |
| P7 | Nenhuma sanção é emitida automaticamente por IA (seção 6). | O sistema não tem conceito de advertência; só alertas à supervisão e relatório. |
| P8 | Dois modos: **Fase A** (auditoria silenciosa) e **Fase B** (instrutor interativo, só após ativação autorizada) (5.1). | Fase A é o padrão. Fase B exige dupla trava (variável do serviço + variável do n8n) e aprovação formal. |
| P9 | Comunicação educativa: breve, respeitosa, sem ameaça, sem ranking, sem pedir documentos fora do canal (5.4). | Regras codificadas no prompt do instrutor e validadas pelo esquema de saída. |
| P10 | Privacidade/LGPD (seção 7): v1.0 proíbe salvar conteúdo fora do grupo; armazenamento técnico exige política atualizada aprovada. | Nada é extraído nem armazenado até aprovação. O esquema de banco existe, mas não deve ser aplicado antes disso. |
| P11 | A API oficial do WhatsApp pode não aceitar os grupos existentes (seção 7). | A arquitetura isola o "provedor de canal" atrás de um contrato canônico, para trocar sem mexer no núcleo. |

## 2. Dicionário de eventos (Anexo A) → regras de reconhecimento

| Evento do POP | Padrão reconhecido (normalizado: maiúsculas, sem acento, sem travessão) | Campos obrigatórios | Evidências esperadas |
|---|---|---|---|
| INICIO DE ROTA DIA DD/MM/AAAA | `INICIO (DE|DA) ROTA` | data válida | foto placa, foto KM inicial, foto combustível |
| DESLOCAMENTO PRIMEIRO CLIENTE COD. XXXX | `DESLOCAMENTO PRIMEIRO CLIENTE` | código | foto nota 1º cliente, print GPS |
| CHEGADA NO CLIENTE COD. XXXX | `CHEGADA (NO|AO) CLIENTE` | código | localização atual nativa do WhatsApp |
| DESCARGA INICIADA | `DESCARGA INICIADA` | — | (marca de tempo) |
| PESAGEM | fotos (texto opcional `PESAGEM`) | — | foto com etiqueta + visor no mesmo quadro, uma por caixa |
| CLIENTE SEM BALANÇA NO RECEBIMENTO — COD. XXXX | `CLIENTE SEM BALANCA` | código | fotos contáveis das caixas + registro de aviso à supervisão |
| PROBLEMA NA ENTREGA — COD. XXXX | `PROBLEMA NA ENTREGA` | código | descrição, escalonamento, solução registrada |
| DESCARGA FINALIZADA — COD. XXXX | `DESCARGA FINALIZADA` | código | foto nota assinada/carimbada |
| DESLOCAMENTO CLIENTE COD. XXXX | `DESLOCAMENTO CLIENTE` | código | foto baú, foto nota próximo cliente, print GPS |
| FIM DE ROTA DIA DD/MM/AAAA | `FIM (DE|DA) ROTA` | data válida | foto KM final, foto combustível final |

Regras adicionais implementadas: variações de preposição são aceitas; mensagem com dois padrões é **ambígua**;
padrão com campo obrigatório ausente é **ambíguo**; texto sem padrão é **conversa livre** (não vira evento).

## 3. Classificação de evidências (5.2) → mapeamento no software

| Resultado | Quando o software atribui |
|---|---|
| CONFORME | Evidência do tipo esperado, legível (IA), vinculada ao escopo certo pelo contexto cronológico; para pesagem, diferença zero (ou dentro de tolerância parametrizada). |
| PENDENTE | Item do checklist sem nenhuma evidência recebida; ou análise automática indisponível (foto guardada, aguardando). |
| ILEGÍVEL / NÃO VERIFICÁVEL | IA não leu o essencial; pesagem sem etiqueta e visor no mesmo quadro; localização enviada como pin em vez de "localização atual"; imagem sem relação com o POP. |
| DIVERGENTE | Diferença etiqueta × balança; localização fora do raio de referência do cliente (quando há referência confiável); código informado diferente do contexto. |
| NÃO CONFORME | PENDENTE não regularizado após o marco parametrizado pela gestão (desligado por padrão). |
| EXCEÇÃO SEM BALANÇA | Tratamento 4-B declarado; sempre com acompanhamento específico. |

## 4. Quadro rápido de conferência (seção 4) → checklist por escopo

- **Saída:** mensagem INICIO DE ROTA; placa; KM inicial; combustível; nota do 1º cliente; print GPS.
- **Por cliente:** (a partir do 2º) baú, nota, print GPS; chegada com código correto + localização; DESCARGA INICIADA;
  pesagens (ou exceção 4-B); DESCARGA FINALIZADA + nota assinada; tratamento de divergências.
- **Retorno:** mensagem FIM DE ROTA; KM final; combustível final.

A vinculação de uma foto a um cliente segue o **último DESLOCAMENTO/CHEGADA anterior à foto**. Fotos antes do
primeiro deslocamento pertencem à saída; fotos após FIM DE ROTA (dentro de uma janela de tolerância) pertencem ao retorno.

## 5. Lacunas e ambiguidades do POP (e a decisão de projeto adotada)

| # | Lacuna | Decisão adotada no projeto | Precisa de aprovação? |
|---|---|---|---|
| L1 | Não há tolerância de pesagem. | Toda diferença sinaliza; parâmetro `weighing_tolerance_kg` nasce nulo. | Sim (A4) |
| L2 | "Marco definido" para NÃO CONFORME não é definido; "prazos de alerta exigem parametrização gerencial". | Parâmetros nulos por padrão: nada vira NÃO CONFORME automaticamente; alertas de atraso desligados. | Sim (A6) |
| L3 | KM/combustível inicial × final são visualmente indistinguíveis. | O contexto da rota decide (antes/depois de FIM DE ROTA), não a IA. | Não |
| L4 | A nota pode não listar caixas/pesos individuais → cobertura das pesagens não verificável. | Relatório indica "limitação de cobertura"; conferência de quantidade depende de fonte da nota. | Sim (A12) |
| L5 | Conferência de localização "depende de referência confiável do endereço". | Só confere quando o cadastro do cliente tem coordenadas + raio; caso contrário, registra sem conferir. | Sim (A7) |
| L6 | O registro de "aviso à supervisão" na exceção 4-B é telefônico e não aparece nas mensagens. | O sistema registra a exceção e alerta a supervisão; confirmação do telefonema é humana. | Não |
| L7 | Mensagens de evento fora de ordem (ex.: CHEGADA sem DESLOCAMENTO). | Registradas como "problema de sequência"; não bloqueiam, viram alerta. | Não |
| L8 | Novo INICIO DE ROTA com rota anterior ainda aberta. | Rota anterior é encerrada administrativamente e fica com pendências visíveis. | Não |
| L9 | Mensagens em texto livre do motorista (dúvidas, relatos). | Fase A: viram alerta INFO para a supervisão responder; a IA não responde ao motorista. | Não |
| L10 | Canal: API oficial pode não aceitar grupos. | Contrato canônico de mensagem; provedor fica no n8n. | Sim (A1) |
| L11 | Retenção, descarte e acesso por função "definidos pela empresa". | Esquema com RLS por papel e parâmetros de retenção nulos; rotina de expurgo desativada. | Sim (A2, A8) |
| L12 | "Responsável / aprovação: a definir pela Fripoint". | O sistema registra quem reconhece alertas e decide revisões; o dono do POP precisa existir. | Sim (A9) |

## 6. O que o POP exige do "professor" (Fase B)

Para cada etapa, o POP já traz o tríptico **ENVIE / COMO / POR QUÊ** (seção 3). O instrutor reaproveita esse
material: a próxima etapa esperada vem do motor de estado, e a IA redige a orientação respeitando 5.4
(até 3 frases, primeiro nome, padrão exato da mensagem, sem ameaça, sem repetição). O conteúdo pedagógico
por etapa está no prompt `INSTRUCTOR_SYSTEM` e pode ser revisado pela supervisão antes da ativação.
