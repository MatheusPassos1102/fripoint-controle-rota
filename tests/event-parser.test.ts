import { describe, expect, it } from "vitest";
import { extractClientCode, extractRouteDate, normalizeText, parseMessage } from "../src/domain/event-parser.js";

describe("normalizeText", () => {
  it("remove acentos, caixa e espaços extras (Anexo A)", () => {
    expect(normalizeText("  cliente sem BALANÇA   no   recebimento — cod. 0042 ")).toBe(
      "CLIENTE SEM BALANCA NO RECEBIMENTO COD. 0042",
    );
  });
});

describe("extractClientCode / extractRouteDate", () => {
  it("extrai código após COD., COD e CODIGO", () => {
    expect(extractClientCode("CHEGADA NO CLIENTE COD. 1234")).toBe("1234");
    expect(extractClientCode("CHEGADA NO CLIENTE COD 1234")).toBe("1234");
    expect(extractClientCode("CHEGADA NO CLIENTE CODIGO AB12")).toBe("AB12");
    expect(extractClientCode("CHEGADA NO CLIENTE")).toBeNull();
  });
  it("converte DD/MM/AAAA e rejeita datas inválidas", () => {
    expect(extractRouteDate("INICIO DE ROTA DIA 27/07/2026")).toBe("2026-07-27");
    expect(extractRouteDate("INICIO DE ROTA DIA 31/02/2026")).toBeNull();
    expect(extractRouteDate("INICIO DE ROTA")).toBeNull();
  });
});

describe("parseMessage — dicionário do Anexo A", () => {
  it.each([
    ["INICIO DE ROTA DIA 27/07/2026", "INICIO_ROTA", null, "2026-07-27"],
    ["inicio de rota dia 05/08/2026", "INICIO_ROTA", null, "2026-08-05"],
    ["DESLOCAMENTO PRIMEIRO CLIENTE COD. 1001", "DESLOCAMENTO_PRIMEIRO_CLIENTE", "1001", null],
    ["Chegada no cliente cod. 1001", "CHEGADA_CLIENTE", "1001", null],
    ["DESCARGA INICIADA", "DESCARGA_INICIADA", null, null],
    ["CLIENTE SEM BALANÇA NO RECEBIMENTO — COD. 1001", "CLIENTE_SEM_BALANCA", "1001", null],
    ["PROBLEMA NA ENTREGA — COD. 1001", "PROBLEMA_ENTREGA", "1001", null],
    ["DESCARGA FINALIZADA — COD. 1001", "DESCARGA_FINALIZADA", "1001", null],
    ["DESLOCAMENTO CLIENTE COD. 2002", "DESLOCAMENTO_CLIENTE", "2002", null],
    ["FIM DE ROTA DIA 27/07/2026", "FIM_ROTA", null, "2026-07-27"],
  ])("%s → %s", (text, eventType, clientCode, routeDate) => {
    const outcome = parseMessage(text);
    expect(outcome.status).toBe("MATCHED");
    expect(outcome.event?.eventType).toBe(eventType);
    expect(outcome.event?.clientCode).toBe(clientCode);
    expect(outcome.event?.routeDate).toBe(routeDate);
  });

  it("não confunde DESLOCAMENTO PRIMEIRO CLIENTE com DESLOCAMENTO CLIENTE", () => {
    expect(parseMessage("DESLOCAMENTO PRIMEIRO CLIENTE COD. 1001").event?.eventType).toBe("DESLOCAMENTO_PRIMEIRO_CLIENTE");
    expect(parseMessage("DESLOCAMENTO CLIENTE COD. 1001").event?.eventType).toBe("DESLOCAMENTO_CLIENTE");
  });

  it("marca como AMBIGUOUS quando falta o código do cliente (nunca associar ao cliente errado)", () => {
    const outcome = parseMessage("CHEGADA NO CLIENTE");
    expect(outcome.status).toBe("AMBIGUOUS");
    expect(outcome.event).toBeNull();
  });

  it("marca como AMBIGUOUS quando falta data válida no início/fim de rota", () => {
    expect(parseMessage("INICIO DE ROTA").status).toBe("AMBIGUOUS");
    expect(parseMessage("FIM DE ROTA DIA 99/99/2026").status).toBe("AMBIGUOUS");
  });

  it("marca como AMBIGUOUS quando dois padrões aparecem na mesma mensagem", () => {
    const outcome = parseMessage("CHEGADA NO CLIENTE COD. 1 DESCARGA INICIADA");
    expect(outcome.status).toBe("AMBIGUOUS");
  });

  it("devolve NO_MATCH para texto livre e mensagens vazias", () => {
    expect(parseMessage("bom dia pessoal, trânsito pesado hoje").status).toBe("NO_MATCH");
    expect(parseMessage("").status).toBe("NO_MATCH");
    expect(parseMessage(null).status).toBe("NO_MATCH");
  });
});
