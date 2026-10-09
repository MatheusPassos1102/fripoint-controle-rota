/**
 * Implementação Supabase da porta de persistência (Postgres + Storage).
 * Tabelas: ver supabase/migrations/0001_initial_schema.sql.
 *
 * Usa a chave service_role SOMENTE no backend. Nenhuma conexão é aberta na importação;
 * o cliente é criado quando o repositório é instanciado com URL e chave presentes.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RouteStatus } from "../domain/route-state.js";
import type { InboundMessage, RouteEvent, RouteEvidence } from "../domain/types.js";
import {
  DEFAULT_SETTINGS,
  type Alert,
  type ClientRecord,
  type Driver,
  type InstructorLog,
  type NewAlert,
  type NewEvent,
  type NewEvidence,
  type Repository,
  type ReviewItem,
  type Route,
  type RouteReportRecord,
  type StoredMessage,
  type SystemSettings,
} from "./repository.js";

export interface SupabaseRepositoryConfig {
  url: string;
  serviceRoleKey: string;
  storageBucket: string;
}

export function supabaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseRepositoryConfig | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY, storageBucket: env.SUPABASE_STORAGE_BUCKET || "evidencias" };
}

type Row = Record<string, unknown>;

export class SupabaseRepository implements Repository {
  private readonly db: SupabaseClient;

  constructor(private readonly config: SupabaseRepositoryConfig) {
    this.db = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false } });
  }

  private async one<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T | null> {
    const { data, error } = await query;
    if (error) throw new Error(`Supabase: ${error.message}`);
    return (data as T) ?? null;
  }

  private async many<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
    const { data, error } = await query;
    if (error) throw new Error(`Supabase: ${error.message}`);
    return (data as T[]) ?? [];
  }

  async getSettings(): Promise<SystemSettings> {
    const rows = await this.many<{ key: string; value: unknown }>(this.db.from("system_settings").select("key,value"));
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const num = (k: string, fallback: number | null) => {
      const v = map.get(k);
      return typeof v === "number" ? v : v === null ? null : fallback;
    };
    return {
      weighingToleranceKg: num("weighing_tolerance_kg", DEFAULT_SETTINGS.weighingToleranceKg),
      pendingToNonConformAfterRouteEndMinutes: num("pending_to_nonconform_after_route_end_minutes", DEFAULT_SETTINGS.pendingToNonConformAfterRouteEndMinutes),
      minClassificationConfidence: num("min_classification_confidence", DEFAULT_SETTINGS.minClassificationConfidence) ?? DEFAULT_SETTINGS.minClassificationConfidence,
      minEvidenceConfidence: num("min_evidence_confidence", DEFAULT_SETTINGS.minEvidenceConfidence) ?? DEFAULT_SETTINGS.minEvidenceConfidence,
      instructorRepeatWindowMinutes: num("instructor_repeat_window_minutes", DEFAULT_SETTINGS.instructorRepeatWindowMinutes) ?? DEFAULT_SETTINGS.instructorRepeatWindowMinutes,
      postRouteGraceMinutes: num("post_route_grace_minutes", DEFAULT_SETTINGS.postRouteGraceMinutes) ?? DEFAULT_SETTINGS.postRouteGraceMinutes,
    };
  }

  async findDriverByGroup(groupId: string): Promise<Driver | null> {
    const row = await this.one<Row>(this.db.from("drivers").select("*").eq("whatsapp_group_id", groupId).eq("active", true).maybeSingle());
    return row ? toDriver(row) : null;
  }
  async getDriver(driverId: string): Promise<Driver | null> {
    const row = await this.one<Row>(this.db.from("drivers").select("*").eq("id", driverId).maybeSingle());
    return row ? toDriver(row) : null;
  }
  async findClient(code: string): Promise<ClientRecord | null> {
    const row = await this.one<Row>(this.db.from("clients").select("*").eq("code", code).maybeSingle());
    return row
      ? {
          code: row.code as string,
          name: row.name as string,
          latitude: (row.latitude as number | null) ?? null,
          longitude: (row.longitude as number | null) ?? null,
          arrivalRadiusMeters: (row.arrival_radius_meters as number | null) ?? null,
        }
      : null;
  }

  async getOpenRoute(driverId: string): Promise<Route | null> {
    const row = await this.one<Row>(this.db.from("routes").select("*").eq("driver_id", driverId).eq("status", "ABERTA").order("opened_at", { ascending: false }).limit(1).maybeSingle());
    return row ? toRoute(row) : null;
  }
  async getLastClosedRoute(driverId: string): Promise<Route | null> {
    const row = await this.one<Row>(this.db.from("routes").select("*").eq("driver_id", driverId).eq("status", "ENCERRADA").order("closed_at", { ascending: false }).limit(1).maybeSingle());
    return row ? toRoute(row) : null;
  }
  async getRoute(routeId: string): Promise<Route | null> {
    const row = await this.one<Row>(this.db.from("routes").select("*").eq("id", routeId).maybeSingle());
    return row ? toRoute(row) : null;
  }
  async openRoute(driverId: string, routeDate: string | null, openedAt: string): Promise<Route> {
    const row = await this.one<Row>(this.db.from("routes").insert({ driver_id: driverId, route_date: routeDate, status: "ABERTA", opened_at: openedAt }).select("*").single());
    return toRoute(row!);
  }
  async closeRoute(routeId: string, closedAt: string): Promise<void> {
    await this.one(this.db.from("routes").update({ status: "ENCERRADA", closed_at: closedAt }).eq("id", routeId));
  }
  async listRoutes(filter: { status?: Route["status"]; driverId?: string }): Promise<Route[]> {
    let q = this.db.from("routes").select("*").order("opened_at", { ascending: false });
    if (filter.status) q = q.eq("status", filter.status);
    if (filter.driverId) q = q.eq("driver_id", filter.driverId);
    return (await this.many<Row>(q)).map(toRoute);
  }

  async saveMessage(msg: InboundMessage, routeId: string | null, parseStatus: StoredMessage["parseStatus"], parseReason: string) {
    const existing = await this.one<Row>(this.db.from("messages").select("id").eq("provider_message_id", msg.providerMessageId).maybeSingle());
    if (existing) return { id: existing.id as string, duplicate: true };
    const row = await this.one<Row>(
      this.db
        .from("messages")
        .insert({
          route_id: routeId,
          provider_message_id: msg.providerMessageId,
          group_id: msg.groupId,
          sender_id: msg.senderId,
          received_at: msg.receivedAt,
          text: msg.text ?? null,
          has_media: Boolean(msg.media),
          media_mime_type: msg.media?.mimeType ?? null,
          location: msg.location ?? null,
          parse_status: parseStatus,
          parse_reason: parseReason,
        })
        .select("id")
        .single(),
    );
    return { id: row!.id as string, duplicate: false };
  }

  async saveEvent(ev: NewEvent): Promise<RouteEvent> {
    const row = await this.one<Row>(
      this.db
        .from("route_events")
        .insert({
          route_id: ev.routeId,
          source_message_id: ev.sourceMessageId,
          event_type: ev.eventType,
          client_code: ev.clientCode,
          occurred_at: ev.occurredAt,
          origin: ev.origin,
          needs_review: ev.needsReview,
        })
        .select("*")
        .single(),
    );
    return toEvent(row!);
  }
  async listEvents(routeId: string): Promise<RouteEvent[]> {
    return (await this.many<Row>(this.db.from("route_events").select("*").eq("route_id", routeId).order("occurred_at"))).map(toEvent);
  }

  async saveEvidence(ev: NewEvidence): Promise<RouteEvidence> {
    const row = await this.one<Row>(
      this.db
        .from("evidences")
        .insert({
          route_id: ev.routeId,
          source_message_id: ev.sourceMessageId,
          kind: ev.kind,
          result: ev.result,
          received_at: ev.receivedAt,
          captured_at: ev.capturedAt,
          client_code: ev.clientCode,
          storage_path: ev.storagePath,
          sha256: ev.sha256,
          fields: ev.fields,
          analysis: ev.analysis,
          reason: ev.reason,
          needs_review: ev.needsReview,
          served_by_model: ev.servedByModel,
        })
        .select("*")
        .single(),
    );
    return toEvidence(row!);
  }
  async listEvidences(routeId: string): Promise<RouteEvidence[]> {
    return (await this.many<Row>(this.db.from("evidences").select("*").eq("route_id", routeId).order("received_at"))).map(toEvidence);
  }
  async listEvidenceDetails(routeId: string): Promise<NewEvidence[]> {
    return (await this.many<Row>(this.db.from("evidences").select("*").eq("route_id", routeId).order("received_at"))).map((r) => ({
      routeId: r.route_id as string,
      sourceMessageId: r.source_message_id as string,
      kind: r.kind as NewEvidence["kind"],
      result: r.result as NewEvidence["result"],
      receivedAt: r.received_at as string,
      capturedAt: (r.captured_at as string | null) ?? null,
      clientCode: (r.client_code as string | null) ?? null,
      storagePath: (r.storage_path as string | null) ?? null,
      sha256: (r.sha256 as string | null) ?? null,
      fields: (r.fields as NewEvidence["fields"]) ?? null,
      analysis: r.analysis,
      reason: (r.reason as string) ?? "",
      needsReview: Boolean(r.needs_review),
      servedByModel: (r.served_by_model as string | null) ?? null,
    }));
  }
  async findEvidenceBySha256(driverId: string, sha256: string) {
    const row = await this.one<Row>(
      this.db.from("evidences").select("route_id,source_message_id,routes!inner(driver_id)").eq("sha256", sha256).eq("routes.driver_id", driverId).limit(1).maybeSingle(),
    );
    return row ? { routeId: row.route_id as string, sourceMessageId: row.source_message_id as string } : null;
  }

  async storeMedia(path: string, bytes: Uint8Array, mimeType: string): Promise<string> {
    const { error } = await this.db.storage.from(this.config.storageBucket).upload(path, bytes, { contentType: mimeType, upsert: false });
    if (error) throw new Error(`Supabase Storage: ${error.message}`);
    return `${this.config.storageBucket}/${path}`;
  }

  async saveRouteStatusSnapshot(routeId: string, status: RouteStatus): Promise<void> {
    await this.one(this.db.from("route_status_snapshots").insert({ route_id: routeId, status }));
  }
  async getLatestRouteStatus(routeId: string): Promise<RouteStatus | null> {
    const row = await this.one<Row>(this.db.from("route_status_snapshots").select("status").eq("route_id", routeId).order("created_at", { ascending: false }).limit(1).maybeSingle());
    return (row?.status as RouteStatus | undefined) ?? null;
  }

  async saveAlert(alert: NewAlert): Promise<Alert> {
    const row = await this.one<Row>(
      this.db
        .from("alerts")
        .insert({ route_id: alert.routeId, kind: alert.kind, severity: alert.severity, title: alert.title, details: alert.details, source_message_id: alert.sourceMessageId })
        .select("*")
        .single(),
    );
    return toAlert(row!);
  }
  async listPendingAlerts(): Promise<Alert[]> {
    return (await this.many<Row>(this.db.from("alerts").select("*").is("acknowledged_at", null).order("created_at"))).map(toAlert);
  }
  async acknowledgeAlert(alertId: string, by: string): Promise<void> {
    await this.one(this.db.from("alerts").update({ acknowledged_at: new Date().toISOString(), acknowledged_by: by }).eq("id", alertId));
  }

  async saveReviewItem(item: ReviewItem): Promise<void> {
    await this.one(this.db.from("review_items").insert({ route_id: item.routeId, source_message_id: item.sourceMessageId, kind: item.kind, payload: item.payload }));
  }

  async saveInstructorLog(log: InstructorLog): Promise<void> {
    await this.one(this.db.from("instructor_messages").insert({ route_id: log.routeId, trigger: log.trigger, item_keys: log.itemKeys, message: log.message, sent: log.sent, created_at: log.createdAt }));
  }
  async recentInstructorItemKeys(routeId: string, withinMinutes: number, now: Date): Promise<string[]> {
    const since = new Date(now.getTime() - withinMinutes * 60_000).toISOString();
    const rows = await this.many<{ item_keys: string[] }>(this.db.from("instructor_messages").select("item_keys").eq("route_id", routeId).gte("created_at", since));
    return rows.flatMap((r) => r.item_keys ?? []);
  }

  async saveReport(report: RouteReportRecord): Promise<void> {
    await this.one(
      this.db.from("route_reports").upsert(
        { route_id: report.routeId, generated_at: report.generatedAt, status: report.status, narrative: report.narrative, markdown: report.markdown, served_by_model: report.servedByModel },
        { onConflict: "route_id" },
      ),
    );
  }
  async getReport(routeId: string): Promise<RouteReportRecord | null> {
    const row = await this.one<Row>(this.db.from("route_reports").select("*").eq("route_id", routeId).maybeSingle());
    return row
      ? {
          routeId: row.route_id as string,
          generatedAt: row.generated_at as string,
          status: row.status as RouteStatus,
          narrative: row.narrative,
          markdown: row.markdown as string,
          servedByModel: (row.served_by_model as string | null) ?? null,
        }
      : null;
  }
}

function toDriver(r: Row): Driver {
  return { id: r.id as string, fullName: r.full_name as string, firstName: r.first_name as string, whatsappGroupId: r.whatsapp_group_id as string, active: Boolean(r.active) };
}
function toRoute(r: Row): Route {
  return {
    id: r.id as string,
    driverId: r.driver_id as string,
    routeDate: (r.route_date as string | null) ?? null,
    status: r.status as Route["status"],
    openedAt: r.opened_at as string,
    closedAt: (r.closed_at as string | null) ?? null,
  };
}
function toEvent(r: Row): RouteEvent {
  return { id: r.id as string, eventType: r.event_type as RouteEvent["eventType"], clientCode: (r.client_code as string | null) ?? null, occurredAt: r.occurred_at as string, sourceMessageId: r.source_message_id as string };
}
function toEvidence(r: Row): RouteEvidence {
  return {
    id: r.id as string,
    kind: r.kind as RouteEvidence["kind"],
    result: r.result as RouteEvidence["result"],
    sourceMessageId: r.source_message_id as string,
    receivedAt: r.received_at as string,
    clientCode: (r.client_code as string | null) ?? null,
    fields: (r.fields as RouteEvidence["fields"]) ?? undefined,
  };
}
function toAlert(r: Row): Alert {
  return {
    id: r.id as string,
    routeId: r.route_id as string,
    kind: r.kind as Alert["kind"],
    severity: r.severity as Alert["severity"],
    title: r.title as string,
    details: (r.details as Record<string, unknown>) ?? {},
    sourceMessageId: (r.source_message_id as string | null) ?? null,
    createdAt: r.created_at as string,
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
  };
}
