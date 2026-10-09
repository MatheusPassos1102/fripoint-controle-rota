# 03 — Pontos que ainda precisam de aprovação

Cada item abaixo bloqueia uma etapa da implantação. O código já está preparado para qualquer das opções indicadas;
a decisão é da Fripoint. Sugestão: registrar a decisão, o responsável e a data na última coluna e versionar este arquivo.

| ID | Ponto | Por que é necessário (referência no POP) | Opções | Bloqueia | Decisão / responsável / data |
|---|---|---|---|---|---|
| **A1** | **Canal de integração com os grupos de WhatsApp** | A API oficial (WhatsApp Business Platform) não dá acesso a grupos existentes; a minuta "não pressupõe que a API oficial aceite os grupos" (seção 7). | (a) migrar para conversas 1:1 oficiais por motorista; (b) provedor não oficial com acesso a grupos (risco de bloqueio de número e de termos de uso); (c) número corporativo adicionado aos grupos via provedor que suporte grupos. | Piloto (fase 1) | |
| **A2** | **Política de armazenamento técnico (LGPD)** | A v1.0 proíbe salvar conteúdo fora do grupo. Guardar cópias (imagens, mensagens, localização) exige política atualizada aprovada que autorize apenas o estritamente necessário em sistemas corporativos (seção 7). | Aprovar política; definir base legal; definir quais dados são copiados (ex.: imagem integral × só campos lidos). | Aplicar a migração; qualquer ingestão real | |
| **A3** | **Uso da Claude API (Anthropic) como operador de dados** | Imagens de notas fiscais, dados de clientes e geolocalização são enviados a um provedor de IA; "exige avaliação prévia de base legal, contratos, segurança, transparência e fluxo de dados" (seção 7). | Avaliação jurídica/DPO; contrato (DPA) com a Anthropic; registro no inventário de dados; transparência aos motoristas e clientes. Decidir também se o fallback server-side fica ligado (reexecuta em outro modelo da Anthropic). | Piloto | |
| **A4** | **Tolerância de pesagem** | O POP não define tolerância e proíbe inventar limite (5.3). Hoje **toda** diferença gera alerta URGENTE, o que pode gerar volume alto. | (a) manter sem tolerância; (b) parametrizar `weighing_tolerance_kg` após medir no piloto; (c) tolerância por tipo de produto (exige cadastro). | Fase A completa | |
| **A5** | **Ativação da Fase B (instrutor interativo)** | Só "após ativação autorizada" (5.1); exige treinamento prévio e ciência dos motoristas (seção 8). | Autorizar; definir período de revisão humana das mensagens antes de ir ao grupo; aprovar o texto-base do instrutor (`src/claude/prompts.ts`). | Fase 3 | |
| **A6** | **Marco para NÃO CONFORME e prazos de alerta** | "Pendência não regularizada após marco definido" (5.2) e "prazos de alerta exigem parametrização gerencial" (Anexo A). Hoje nada vira NÃO CONFORME automaticamente. | Definir `pending_to_nonconform_after_route_end_minutes` e `alert_pending_after_minutes`. | Fase A completa | |
| **A7** | **Referência confiável de endereço dos clientes** | "A conferência de localização depende de referência confiável do endereço" (Anexo A). Sem coordenadas + raio, o sistema registra a localização sem conferir. | Fornecer cadastro (código, nome, coordenadas, raio) — pode vir do ERP; decidir raio padrão. | Conferência de chegada | |
| **A8** | **Retenção, descarte e acesso por função** | "Acesso restrito por função, trilha de auditoria, retenção e descarte definidos pela empresa" (seção 7). | Definir dias de retenção de imagens e mensagens; quem é `supervisao` e quem é `gestao`; ativar rotina de expurgo. | Fase A completa | |
| **A9** | **Dono do POP e aprovação da v1.1** | "Responsável / aprovação: a definir pela Fripoint"; a v1.1 só substitui a 1.0 após aprovação. O sistema implementa a v1.1. | Nomear responsável; aprovar a minuta (ou indicar alterações que afetem as regras aqui implementadas). | Piloto | |
| **A10** | **Cadastro dos 8 motoristas, grupos e ciência** | Cada grupo precisa estar vinculado a um motorista; treinamento e ciência antes da vigência (seção 8). | Lista de motoristas, IDs dos grupos, registro de treinamento/ciência (`drivers.consent_acknowledged_at`). | Piloto | |
| **A11** | **Destinatários e formato dos alertas e relatórios** | A supervisão recebe alertas em tempo real e relatório ao fim da rota (5.1). | E-mail, WhatsApp da supervisão, painel; quem reconhece alertas; horário de corte do relatório. | Piloto | |
| **A12** | **Fonte dos dados da nota fiscal (caixas e pesos por caixa)** | Sem isso a auditoria só indica "limitação de cobertura" das pesagens (5.3). | (a) aceitar limitação; (b) leitura da nota pela IA (OCR) com validação humana; (c) integração com ERP/NF-e. | Fase 4 | |
| **A13** | **Hospedagem do serviço e do n8n** | Dados pessoais e de clientes; self-hosted reduz terceiros. | VPS própria × nuvem gerenciada; n8n self-hosted × Cloud; região do Supabase. | Piloto | |
| **A14** | **Cadastro de clientes sem balança conhecidos** | Exceção 4-B gera "plano de auditoria volante" (seção 6). | Marcar `clients.has_scale` para antecipar a exceção e orientar o motorista (Fase B). | Fase 3 | |

## Decisões já tomadas no projeto (não precisam de aprovação, mas podem ser revistas)

- Fase A é o padrão; o sistema nunca escreve no grupo do motorista sem A5.
- Parâmetros sensíveis (tolerância, marcos, retenção) nascem nulos: ausência de parâmetro significa "não aplicar".
- Evento classificado por IA a partir de mensagem fora do padrão sempre fica marcado para revisão humana.
- Imagem idêntica a outra já recebida (mesmo SHA-256) gera alerta "para averiguação humana", nunca "fraude".
- Fotos enviadas até 240 min após FIM DE ROTA pertencem à rota encerrada (janela configurável).
- Modelo único `claude-opus-5-5` em todas as operações; troca por operação é possível, mas deve ser decidida com dados de custo do piloto.
