/**
 * Implementação em memória da porta de persistência — usada por testes e pela simulação offline.
 * Não acessa rede nem disco.
 */

import { randomUUID } from "node:crypto";
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

export class InMemoryRepository implements Repository {
  settings: SystemSettings = { ...DEFAULT_SETTINGS };
  drivers: Driver[] = [];
  clients: ClientRecord[] = [];
  routes: Route[] = [];
  messages: StoredMessage[] = [];
  events: Array<RouteEvent & NewEvent> = [];
  evidences: Array<RouteEvidence & NewEvidence> = [];
  media = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  statusSnapshots = new Map<string, RouteStatus>();
  alerts: Alert[] = [];
  reviewItems: ReviewItem[] = [];
  instructorLogs: InstructorLog[] = [];
  reports = new Map<string, RouteReportRecord>();

  async getSettings() {
    return this.settings;
  }
  async findDriverByGroup(groupId: string) {
    return this.drivers.find((d) => d.whatsappGroupId === groupId && d.active) ?? null;
  }
  async getDriver(driverId: string) {
    return this.drivers.find((d) => d.id === driverId) ?? null;
  }
  async findClient(code: string) {
    return this.clients.find((c) => c.code === code) ?? null;
  }
  async getOpenRoute(driverId: string) {
    return this.routes.find((r) => r.driverId === driverId && r.status === "ABERTA") ?? null;
  }
  async getLastClosedRoute(driverId: string) {
    return (
      this.routes
        .filter((r) => r.driverId === driverId && r.status === "ENCERRADA" && r.closedAt)
        .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!))[0] ?? null
    );
  }
  async getRoute(routeId: string) {
    return this.routes.find((r) => r.id === routeId) ?? null;
  }
  async openRoute(driverId: string, routeDate: string | null, openedAt: string) {
    const route: Route = { id: randomUUID(), driverId, routeDate, status: "ABERTA", openedAt, closedAt: null };
    this.routes.push(route);
    return route;
  }
  async closeRoute(routeId: string, closedAt: string) {
    const r = this.routes.find((x) => x.id === routeId);
    if (r) {
      r.status = "ENCERRADA";
      r.closedAt = closedAt;
    }
  }
  async listRoutes(filter: { status?: Route["status"]; driverId?: string }) {
    return this.routes.filter((r) => (!filter.status || r.status === filter.status) && (!filter.driverId || r.driverId === filter.driverId));
  }
  async saveMessage(msg: InboundMessage, routeId: string | null, parseStatus: StoredMessage["parseStatus"], parseReason: string) {
    const existing = this.messages.find((m) => m.providerMessageId === msg.providerMessageId);
    if (existing) return { id: existing.id, duplicate: true };
    const stored: StoredMessage = {
      id: randomUUID(),
      routeId,
      providerMessageId: msg.providerMessageId,
      receivedAt: msg.receivedAt,
      text: msg.text ?? null,
      hasMedia: Boolean(msg.media),
      parseStatus,
      parseReason,
    };
    this.messages.push(stored);
    return { id: stored.id, duplicate: false };
  }
  async saveEvent(ev: NewEvent) {
    const stored = { ...ev, id: randomUUID() };
    this.events.push(stored);
    return stored;
  }
  async listEvents(routeId: string) {
    return this.events.filter((e) => e.routeId === routeId);
  }
  async saveEvidence(ev: NewEvidence) {
    const stored = { ...ev, id: randomUUID(), fields: ev.fields ?? undefined };
    this.evidences.push(stored as RouteEvidence & NewEvidence);
    return stored as RouteEvidence;
  }
  async listEvidences(routeId: string) {
    return this.evidences.filter((e) => e.routeId === routeId);
  }
  async listEvidenceDetails(routeId: string) {
    return this.evidences.filter((e) => e.routeId === routeId);
  }
  async findEvidenceBySha256(driverId: string, sha256: string) {
    const routeIds = new Set(this.routes.filter((r) => r.driverId === driverId).map((r) => r.id));
    const hit = this.evidences.find((e) => e.sha256 === sha256 && routeIds.has(e.routeId));
    return hit ? { routeId: hit.routeId, sourceMessageId: hit.sourceMessageId } : null;
  }
  async storeMedia(path: string, bytes: Uint8Array, mimeType: string) {
    this.media.set(path, { bytes, mimeType });
    return path;
  }
  async saveRouteStatusSnapshot(routeId: string, status: RouteStatus) {
    this.statusSnapshots.set(routeId, status);
  }
  async getLatestRouteStatus(routeId: string) {
    return this.statusSnapshots.get(routeId) ?? null;
  }
  async saveAlert(alert: NewAlert) {
    const stored: Alert = { ...alert, id: randomUUID(), createdAt: new Date().toISOString(), acknowledgedAt: null };
    this.alerts.push(stored);
    return stored;
  }
  async listPendingAlerts() {
    return this.alerts.filter((a) => !a.acknowledgedAt);
  }
  async acknowledgeAlert(alertId: string) {
    const a = this.alerts.find((x) => x.id === alertId);
    if (a) a.acknowledgedAt = new Date().toISOString();
  }
  async saveReviewItem(item: ReviewItem) {
    this.reviewItems.push(item);
  }
  async saveInstructorLog(log: InstructorLog) {
    this.instructorLogs.push(log);
  }
  async recentInstructorItemKeys(routeId: string, withinMinutes: number, now: Date) {
    const since = now.getTime() - withinMinutes * 60_000;
    return this.instructorLogs
      .filter((l) => l.routeId === routeId && Date.parse(l.createdAt) >= since)
      .flatMap((l) => l.itemKeys);
  }
  async saveReport(report: RouteReportRecord) {
    this.reports.set(report.routeId, report);
  }
  async getReport(routeId: string) {
    return this.reports.get(routeId) ?? null;
  }
}
