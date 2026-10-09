/** Validação do payload canônico enviado pelo n8n (ver n8n/workflows/01-ingestao-whatsapp.json). */

import { z } from "zod";
import type { InboundMessage } from "../domain/types.js";

const InboundMessageSchema = z.object({
  providerMessageId: z.string().min(1),
  groupId: z.string().min(1),
  senderId: z.string().min(1),
  receivedAt: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "receivedAt deve ser ISO 8601"),
  text: z.string().nullable().optional(),
  media: z
    .object({
      mimeType: z.string().min(1),
      url: z.string().url().optional(),
      base64: z.string().optional(),
      capturedAt: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  location: z
    .object({ latitude: z.number(), longitude: z.number(), isLive: z.boolean().optional() })
    .nullable()
    .optional(),
});

export function parseInboundMessage(body: unknown): { ok: true; data: InboundMessage } | { ok: false; issues: string[] } {
  const r = InboundMessageSchema.safeParse(body);
  if (!r.success) return { ok: false, issues: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  return { ok: true, data: r.data as InboundMessage };
}
