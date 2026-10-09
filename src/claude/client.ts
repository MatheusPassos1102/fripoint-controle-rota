/**
 * Cliente Claude API e helper de saída estruturada.
 *
 * - Modelo padrão: claude-opus-5-5 (configurável por CLAUDE_MODEL).
 * - Thinking adaptativo (padrão do modelo); profundidade controlada por output_config.effort por tarefa.
 * - Prompt caching: o prompt de sistema é estável e marcado com cache_control.
 * - Fallback server-side em caso de recusa do classificador de segurança (CLAUDE_SERVER_FALLBACK=true):
 *   a requisição é reexecutada em outro modelo dentro da mesma chamada. O modelo que respondeu fica
 *   registrado (servedBy) para trilha de auditoria.
 * - Nenhuma chamada é feita na importação do módulo: só quando uma operação é invocada com chave configurada.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  apiKey?: string;
  model: string;
  serverFallback: boolean;
}

export function claudeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  return {
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    serverFallback: (env.CLAUDE_SERVER_FALLBACK ?? "true").toLowerCase() !== "false",
  };
}

export interface StructuredCallResult<T> {
  data: T;
  /** Modelo que efetivamente respondeu (pode diferir do solicitado quando houve fallback). */
  servedBy: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  requestId: string | null;
}

export class ClaudeRefusalError extends Error {
  constructor(
    public readonly category: string | null,
    public readonly explanation: string | null,
  ) {
    super(`Claude recusou a requisição${category ? ` (categoria ${category})` : ""}`);
    this.name = "ClaudeRefusalError";
  }
}

export class ClaudeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeOutputError";
  }
}

export class ClaudeClient {
  private readonly sdk: Anthropic;

  constructor(private readonly config: ClaudeConfig) {
    if (!config.apiKey) {
      throw new Error("ANTHROPIC_API_KEY não configurada — o serviço não executa chamadas à Claude API sem chave.");
    }
    this.sdk = new Anthropic({ apiKey: config.apiKey });
  }

  get model(): string {
    return this.config.model;
  }

  /**
   * Executa uma chamada com saída estruturada validada por Zod.
   * `system` deve ser estável entre chamadas (cacheado); dados variáveis vão em `content`.
   */
  async structured<S extends z.ZodType>(args: {
    system: string;
    content: Anthropic.Beta.BetaContentBlockParam[];
    schema: S;
    effort: Effort;
    maxTokens?: number;
  }): Promise<StructuredCallResult<z.infer<S>>> {
    const fallbackParams: Pick<Anthropic.Beta.MessageCreateParamsNonStreaming, "betas" | "fallbacks"> = this.config.serverFallback
      ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
      : {};

    const response = await this.sdk.beta.messages.create({
      model: this.config.model,
      max_tokens: args.maxTokens ?? 4096,
      ...fallbackParams,
      system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: args.effort, format: zodOutputFormat(args.schema) },
      messages: [{ role: "user", content: args.content }],
    });

    if (response.stop_reason === "refusal") {
      const details = response.stop_details;
      throw new ClaudeRefusalError(details?.category ?? null, details?.explanation ?? null);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ClaudeOutputError("resposta truncada por max_tokens; aumente maxTokens para esta operação");
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) {
      throw new ClaudeOutputError("resposta sem bloco de texto para interpretar como JSON");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      throw new ClaudeOutputError("resposta não é JSON válido");
    }
    const validation = args.schema.safeParse(parsedJson);
    if (!validation.success) {
      throw new ClaudeOutputError(`resposta não atende ao esquema: ${validation.error.message}`);
    }

    const fallbackUsed = response.content.some((b) => b.type === "fallback") || response.model !== this.config.model;

    return {
      data: validation.data as z.infer<S>,
      servedBy: response.model,
      fallbackUsed,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      requestId: response._request_id ?? null,
    };
  }
}

/** Converte um erro do SDK em mensagem curta para log/trilha, sem vazar segredos. */
export function describeClaudeError(err: unknown): string {
  if (err instanceof ClaudeRefusalError || err instanceof ClaudeOutputError) return err.message;
  if (err instanceof Anthropic.RateLimitError) return "limite de taxa da Claude API — tentar novamente mais tarde";
  if (err instanceof Anthropic.AuthenticationError) return "chave da Claude API inválida";
  if (err instanceof Anthropic.BadRequestError) return `requisição inválida à Claude API: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "falha de conexão com a Claude API";
  if (err instanceof Anthropic.APIError) return `erro ${err.status} da Claude API: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
