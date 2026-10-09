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
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `The app server answered ${res.status}.`);
  return data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
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

// --- Horos ---

export interface Notification { id: number; at: string; level: "error" | "warn" | "info" | "pulse"; kind: string; title: string; body: string; hireId?: string }
export interface HireInfo { id: string; label: string; harness: string; state: string; pid: number }
