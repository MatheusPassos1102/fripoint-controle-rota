/**
 * Parser determinístico das mensagens-padrão do POP-LOG-001 (Anexo A).
 *
 * Regras de projeto:
 *  - Variações de maiúsculas/minúsculas, acentos e espaços são normalizadas (Anexo A).
 *  - Mensagens ambíguas NUNCA são associadas automaticamente a um cliente:
 *    o parser devolve AMBIGUOUS e o caso vai para a IA (classificação) e/ou revisão humana.
 *  - Nenhuma inferência "criativa": só casa com os padrões do dicionário.
 */

import type { EventType, ParseOutcome, ParsedEvent } from "./types.js";

/** Normaliza: maiúsculas, remove acentos, troca travessões/hífens por espaço, colapsa espaços. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[—–\-_:;,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai o código do cliente após "COD." / "COD" / "CODIGO". */
export function extractClientCode(normalized: string): string | null {
  const m = normalized.match(/\bCOD(?:IGO)?\.?\s*([A-Z0-9]{1,20})\b/);
  return m?.[1] ?? null;
}

/** Extrai data DD/MM/AAAA e devolve YYYY-MM-DD; null se ausente ou inválida. */
export function extractRouteDate(normalized: string): string | null {
  const m = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

interface Pattern {
  eventType: EventType;
  /** Testado sobre o texto normalizado. */
  regex: RegExp;
  requiresClientCode: boolean;
  requiresDate: boolean;
}

/**
 * Ordem importa: "DESLOCAMENTO PRIMEIRO CLIENTE" deve ser testado antes de "DESLOCAMENTO CLIENTE".
 * Os padrões aceitam pequenas variações de preposição ("NO CLIENTE" / "CLIENTE").
 */
const PATTERNS: Pattern[] = [
  { eventType: "INICIO_ROTA", regex: /\bINICIO (?:DE |DA )?ROTA\b/, requiresClientCode: false, requiresDate: true },
  { eventType: "FIM_ROTA", regex: /\bFIM (?:DE |DA )?ROTA\b/, requiresClientCode: false, requiresDate: true },
  {
    eventType: "DESLOCAMENTO_PRIMEIRO_CLIENTE",
    regex: /\bDESLOCAMENTO (?:PARA O |AO |PRO )?PRIMEIRO CLIENTE\b/,
    requiresClientCode: true,
    requiresDate: false,
  },
  {
    eventType: "DESLOCAMENTO_CLIENTE",
    regex: /\bDESLOCAMENTO (?:PARA O |AO |PRO )?CLIENTE\b/,
    requiresClientCode: true,
    requiresDate: false,
  },
  { eventType: "CHEGADA_CLIENTE", regex: /\bCHEGADA (?:NO |AO )?CLIENTE\b/, requiresClientCode: true, requiresDate: false },
  { eventType: "DESCARGA_INICIADA", regex: /\bDESCARGA INICIADA\b/, requiresClientCode: false, requiresDate: false },
  { eventType: "DESCARGA_FINALIZADA", regex: /\bDESCARGA FINALIZADA\b/, requiresClientCode: true, requiresDate: false },
  {
    eventType: "CLIENTE_SEM_BALANCA",
    regex: /\bCLIENTE SEM BALANCA\b/,
    requiresClientCode: true,
    requiresDate: false,
  },
  { eventType: "PROBLEMA_ENTREGA", regex: /\bPROBLEMA NA ENTREGA\b/, requiresClientCode: true, requiresDate: false },
  { eventType: "PESAGEM", regex: /^PESAGEM\b/, requiresClientCode: false, requiresDate: false },
];

/**
 * Tenta reconhecer uma mensagem-padrão.
 *
 * - MATCHED: exatamente um padrão casou e os campos obrigatórios foram extraídos.
 * - AMBIGUOUS: mais de um padrão casou, ou faltou campo obrigatório (ex.: código do cliente).
 * - NO_MATCH: texto livre (conversa, dúvida, etc.).
 */
export function parseMessage(text: string | null | undefined): ParseOutcome {
  const normalizedText = normalizeText(text ?? "");
  if (!normalizedText) {
    return { status: "NO_MATCH", event: null, reason: "mensagem sem texto", normalizedText };
  }

  // "DESLOCAMENTO PRIMEIRO CLIENTE" não contém literalmente "DESLOCAMENTO CLIENTE", então os dois
  // padrões de deslocamento não colidem; qualquer outra combinação de padrões é tratada como ambígua.
  const distinct = PATTERNS.filter((p) => p.regex.test(normalizedText));

  if (distinct.length === 0) {
    return { status: "NO_MATCH", event: null, reason: "nenhum padrão do Anexo A reconhecido", normalizedText };
  }
  if (distinct.length > 1) {
    return {
      status: "AMBIGUOUS",
      event: null,
      reason: `mais de um padrão reconhecido: ${distinct.map((p) => p.eventType).join(", ")}`,
      normalizedText,
    };
  }

  const pattern = distinct[0]!;
  const clientCode = extractClientCode(normalizedText);
  const routeDate = extractRouteDate(normalizedText);

  if (pattern.requiresClientCode && !clientCode) {
    return {
      status: "AMBIGUOUS",
      event: null,
      reason: `${pattern.eventType} sem código do cliente identificável`,
      normalizedText,
    };
  }
  if (pattern.requiresDate && !routeDate) {
    return {
      status: "AMBIGUOUS",
      event: null,
      reason: `${pattern.eventType} sem data DD/MM/AAAA válida`,
      normalizedText,
    };
  }

  const event: ParsedEvent = {
    eventType: pattern.eventType,
    clientCode,
    routeDate,
    normalizedText,
  };
  return { status: "MATCHED", event, reason: `padrão ${pattern.eventType}`, normalizedText };
}
