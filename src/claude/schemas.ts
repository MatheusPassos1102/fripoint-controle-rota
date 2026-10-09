/**
 * Esquemas de saída estruturada (Zod) para as chamadas à Claude API.
 * A IA devolve apenas observações; conclusões sobre a rota e cálculos ficam no software.
 */

import { z } from "zod";
import { ASSESSMENT_RESULTS, EVENT_TYPES, EVIDENCE_KINDS } from "../domain/types.js";

export const LEGIBILITY = ["LEGIVEL", "PARCIAL", "ILEGIVEL"] as const;

/** Resultado da análise de uma fotografia/evidência. */
export const EvidenceAnalysisSchema = z.object({
  kind: z.enum(EVIDENCE_KINDS).describe("Tipo de evidência que a imagem representa, conforme o POP"),
  legibility: z.enum(LEGIBILITY),
  fields: z.object({
    plate: z.string().nullable().describe("Placa do veículo, se legível"),
    odometer_km: z.number().nullable().describe("KM do hodômetro, se legível"),
    fuel_level: z.string().nullable().describe("Nível de combustível descrito (ex.: '1/2', 'cheio', '3/4')"),
    invoice_number: z.string().nullable().describe("Número da nota fiscal, se legível"),
    client_code: z.string().nullable().describe("Código do cliente visível no documento, se houver"),
    label_kg: z.number().nullable().describe("Peso em kg impresso na etiqueta da caixa, se legível"),
    scale_kg: z.number().nullable().describe("Peso em kg no visor da balança, se legível"),
    both_in_same_frame: z
      .boolean()
      .nullable()
      .describe("true somente se etiqueta E visor da balança aparecem legíveis no MESMO quadro"),
    boxes_count: z.number().int().nullable().describe("Quantidade de caixas contáveis na imagem"),
    signed_or_stamped: z.boolean().nullable().describe("Nota apresenta assinatura e/ou carimbo visível"),
    gps_destination: z.string().nullable().describe("Endereço/destino exibido no print de navegação"),
  }),
  issues: z
    .array(z.string())
    .describe("Problemas observados: reflexo, corte, distância, desfoque, dado ausente, inconsistência"),
  possible_reuse_indicators: z
    .array(z.string())
    .describe("Indícios de imagem reaproveitada (ex.: data/hora visível incompatível). Nunca afirmar fraude."),
  confidence: z.number().min(0).max(1).describe("Confiança geral na leitura (0 a 1)"),
  summary: z.string().describe("Uma frase objetiva descrevendo o que a imagem comprova ou não"),
});
export type EvidenceAnalysis = z.infer<typeof EvidenceAnalysisSchema>;

/** Classificação de mensagem de texto ambígua (só usada quando o parser determinístico falha). */
export const MessageClassificationSchema = z.object({
  event_type: z.enum(EVENT_TYPES).nullable().describe("Evento do Anexo A ao qual a mensagem corresponde, ou null"),
  client_code: z.string().nullable().describe("Código do cliente citado explicitamente, ou null"),
  route_date: z.string().nullable().describe("Data no formato YYYY-MM-DD se a mensagem declara data de rota"),
  is_problem_report: z.boolean().describe("A mensagem relata um problema/ocorrência em texto livre"),
  is_question_to_supervision: z.boolean().describe("A mensagem é uma dúvida ou pedido de orientação do motorista"),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe("Justificativa curta, citando trechos da mensagem"),
});
export type MessageClassification = z.infer<typeof MessageClassificationSchema>;

/** Mensagem de orientação da Fase B (instrutor). */
export const InstructorMessageSchema = z.object({
  should_send: z.boolean().describe("false quando não há orientação útil ou o momento é inadequado"),
  message: z.string().describe("Texto curto, respeitoso e prático em português do Brasil"),
  teaches: z.object({
    what: z.string().describe("O QUE fazer"),
    how: z.string().describe("COMO fazer"),
    why: z.string().describe("POR QUE é importante"),
  }),
  reinforces_good_practice: z.boolean(),
});
export type InstructorMessage = z.infer<typeof InstructorMessageSchema>;

/** Relatório narrativo de encerramento (os números vêm do software). */
export const RouteReportNarrativeSchema = z.object({
  headline: z.string().describe("Uma linha resumindo o estado documental da rota"),
  summary: z.string().describe("Resumo em 3 a 6 frases, sem inventar números"),
  attention_points: z.array(z.string()).describe("Pontos que exigem avaliação humana da supervisão"),
  training_opportunities: z.array(z.string()).describe("Sugestões de reforço de treinamento (tom educativo)"),
  good_practices: z.array(z.string()).describe("Boas práticas observadas, para reconhecimento"),
});
export type RouteReportNarrative = z.infer<typeof RouteReportNarrativeSchema>;

export const AssessmentResultSchema = z.enum(ASSESSMENT_RESULTS);
