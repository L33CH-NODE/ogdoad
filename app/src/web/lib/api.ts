// Talking to the app server: Money (/ogdoad/money), Horos (/horos) and the Ogdoad server (/api).

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    // The vault locked (idle timeout, or locked elsewhere): tell the app to show the lock.
    if (res.status === 401 && data?.error === "locked") window.dispatchEvent(new Event("ogdoad:locked"));
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `The app server answered ${res.status}.`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  del: <T>(path: string) => call<T>("DELETE", path),
};

// --- Money types (mirroring the server) ---

export type Bucket = "draft" | "void" | "paid" | "current" | "1-30" | "31-60" | "61-90" | "90+";

export interface Settings {
  businessName: string; abn: string; contactEmail: string; contactPhone: string; address: string; gstRegistered: boolean;
  numberPrefix: string; numberWidth: number; nextNumber: number; defaultTermsDays: number; defaultAccountId: string | null; timezone: string; footerNote: string;
}
export interface Account { id: string; label: string; kind: "personal" | "business"; bankName: string; accountName: string; bsb: string; accountNumber: string; archived: boolean }
export interface Client {
  id: string; name: string; contactName: string; email: string; phone: string; address: string; participantName: string; ndisNumber: string;
  termsDays: number | null; payToAccountId: string | null; notes: string; source: string; archived: boolean;
}
export interface InvoiceSummary {
  id: string; number: string | null; status: "draft" | "rejected" | "issued" | "void"; clientId: string; clientName: string; issueDate: string | null; dueDate: string | null;
  serviceFrom: string | null; serviceTo: string | null; totalCents: number; paidCents: number; balanceCents: number; daysOverdue: number | null; bucket: Bucket; source: string;
}
export interface InvoiceLine { id?: string; description: string; quantity: number; unitCents: number; lineCents?: number; serviceDate?: string | null }
export interface Payment { id: string; amountCents: number; receivedOn: string | null; matchedBy: string; evidence: string }
export interface Invoice extends InvoiceSummary {
  termsDays: number; notes: string; participantName: string; ndisNumber: string; payToAccountId: string | null; pdfPath: string | null; voidReason: string | null;
  lines: InvoiceLine[]; payments: Payment[]; events?: Array<{ at: string; actor: string; kind: string; detail: string }>;
}
export interface Finding { kind: string; invoiceIds: string[]; message: string }
export interface GstMeter { thresholdCents: number; windowStart: string; windowEnd: string; turnoverCents: number; percent: number; projectedCents: number; level: "ok" | "watch" | "near" | "over" }
export interface Overview {
  settings: Settings; accounts: Account[]; gst: GstMeter; findings: Finding[]; today: string;
  ageing: Record<"current" | "1-30" | "31-60" | "61-90" | "90+", { count: number; cents: number }>;
  counts: { drafts: number; issued: number; owed: number; clients: number };
  bankToReview: number;
}

export interface AppInfo { practice: boolean; realAppPort: number }
export interface VaultStatus { practice: boolean; exists: boolean; unlocked: boolean; login: string | null; lockMinutes: number }

let appInfo: Promise<AppInfo> | null = null;
/** Whether this is the practice copy (asked once per page load). */
export function getAppInfo(): Promise<AppInfo> {
  return (appInfo ??= api.get<AppInfo>("/ogdoad/app").catch(() => ({ practice: false, realAppPort: 3101 })));
}

// --- Horos ---

export interface Notification { id: number; at: string; level: "error" | "warn" | "info" | "pulse"; kind: string; title: string; body: string; hireId?: string }
export interface HireInfo { id: string; label: string; harness: string; state: string; pid: number; kept?: boolean; role?: "server" | "hire"; provides?: string | null; onDemand?: boolean; startedAt?: string; title?: string }
export interface RosterEntry { id: string; label?: string; harness: string; role?: "server"; provides?: string; onDemand?: boolean; running: boolean; resumable: boolean }

// --- The control center ---

export interface Task {
  id: string; key: string | null; title: string; context: string; source: "you" | "money" | "bank" | "work" | "team"; ref: string | null;
  cents: number | null; dueOn: string | null; urgency: 0 | 1 | 2 | 3; blocking: boolean; state: "open" | "parked" | "done" | "dropped";
  createdAt: string; updatedAt: string; skippedAt: string | null; focusAt: string | null; closedAt: string | null; closedBy: string | null; score?: number;
}
export interface FlowView { now: Task | null; next: Task[]; later: Task[]; parked: Task[]; done: Task[]; doneToday: number; streak: number }
export interface Signal { id: number | string; at: string; who: string; text: string; tone: "good" | "c1" | "warn" | "bad" | "muted" | "primary"; kind: string }
export interface Artifact { id: string; kind: "invoice" | "note" | "document"; title: string; by: string; via: string; at: string; tier: string; cloudSaw: string; sealed: boolean; open: string | null; ref: string; source?: { issueId: string; key: string } }

// --- Work types (mirroring the server) ---

export interface Shift {
  id: string; clientId: string; clientName: string; participantName: string; day: string; start: string; end: string; minutes: number;
  support: string; rateCents: number; km: number; kmRateCents: number; cents: number; status: "planned" | "done" | "cancelled";
  phase: "ahead" | "now" | "over"; note: "none" | "draft" | "final"; incident: boolean; incidentReported: boolean;
  billed: { invoiceId: string; status: string; number: string | null } | null; seriesId: string | null; standIn: string;
}
export interface ShiftNote { body: string; goals: string; followUp: string; incident: boolean; incidentDetail: string; incidentReportedAt: string | null; final: boolean; writtenBy: string; updatedAt: string }
export interface ShiftDetail extends Shift { noteText: ShiftNote | null }
export interface Billable { clientId: string; clientName: string; shifts: number; cents: number; from: string; to: string; waitingOnNotes: number }
export interface Month { month: string; invoicedCents: number; receivedCents: number }
export interface SophiaInfo { companyId: string; companyName: string; agentId?: string; taskId: string; hireId?: string }
export interface CalendarSettings { kind: "none" | "caldav"; url: string; username: string; hasPassword: boolean; showNames: boolean; lastSyncAt: string | null; lastError: string | null }
export interface CalendarReport { created: number; updated: number; deleted: number; moved: number; cancelled: number; errors: string[] }

// --- Dashboards ---

export interface ChartSpec { type: "bar" | "line" | "stat" | "table"; x?: string; y?: string[]; format?: "aud" | "number" | "hours" | "percent" }
export type PanelResult = { ok: true; columns: string[]; rows: unknown[][] } | { ok: false; error: string };
export interface Panel { id: string; title: string; sql: string; chart: ChartSpec; madeBy: string; position: number; createdAt: string; result: PanelResult }
export interface Recipe { title: string; sql: string; chart: ChartSpec }

// --- Rooms (mirroring the server) ---

export interface RoomMember { agentId: string; name: string; hireId: string | null; harness: string | null; where: "cloud" | "local" | "either" | "unknown"; paused?: boolean }
export interface RoomPart { id: string; identifier: string | null; title: string; status: string; agentId: string | null; yours: boolean; thread: boolean; createdAt: string; updatedAt: string }
export type RoomMessage =
  | { id: string; at: string; partId: string; kind: "said"; from: "you" | "agent"; agentId: string | null; body: string; warnings?: MembraneWarning[] }
  | { id: string; at: string; partId: string; kind: "opened"; agentId: string | null; byYou: boolean; title: string }
  | { id: string; at: string; partId: string; kind: "note"; body: string };
export interface RoomSummary { id: string; name: string; status: string; color: string | null; lastAt: string; partCount: number; openCount: number; memberIds: string[]; memberHireIds: string[]; hasThread: boolean }
export interface Room extends RoomSummary {
  description: string; leadAgentId: string | null; threadId: string | null; parts: RoomPart[]; members: RoomMember[]; everyone: RoomMember[];
  messages: RoomMessage[]; running: Array<{ agentId: string; issueId: string; status: string; startedAt: string | null }>;
  links: Links; held: Array<{ id: string; kind: OutKind; createdAt: string }>;
}

// --- The membrane (mirroring the server) ---

export type Links = Record<string, { real: string; kind: string }>;
export type OutKind = "say" | "open" | "part" | "prompt" | "hire";
export interface MembraneWarning { kind: "unknown" | "mangled" | "real" | "echo"; text: string; token?: string; why: string }
export interface MembraneChange { start: number; end: number; original: string; token: string; kind: string; source: "books" | "pattern"; why: string }
export interface MembraneFlag { start: number; end: number; text: string; kind: "age" | "condition" | "place" | "maybe-name" | "ambiguous" | "model"; why: string; standIn?: string }
export interface CheckPiece { label: string; real: string; text: string; changes: MembraneChange[]; flags: MembraneFlag[]; edited?: boolean; exposed?: MembraneChange[] }
export interface Recipient { who: string; via: string; where: "cloud" | "local" | "either" | "unknown" }
export interface Check {
  id: string; kind: OutKind; state: "held" | "sent" | "kept" | "dropped"; createdAt: string; projectId: string | null; where: string; reaches: Recipient[];
  pieces: CheckPiece[]; warn: boolean; hold: boolean; digest: string; canKeep: boolean; notes: string[]; links: Links;
}
/** What a send can come back as: done, or held for the operator's check. */
export type MaybeHeld<T> = T | { held: Check };
export const isHeld = <T,>(x: MaybeHeld<T>): x is { held: Check } => !!x && typeof x === "object" && "held" in (x as object);
