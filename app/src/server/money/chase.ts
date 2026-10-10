// Chasing a late invoice, the operator's way: Ogdoad drafts the reminder and the operator sends it
// (Ogdoad never sends anything). The tone follows how late it is: gentle, then firm, then final. The
// draft reminds the operator to check the bank first, and once a reminder is sent, Flow lets the
// invoice rest for a week.

import { daysBetween, MoneyError, type Money } from "./service.js";

export interface ChaseDraft {
  to: string;
  subject: string;
  body: string;
  tone: "gentle" | "firm" | "final";
  daysLate: number;
  /** When a bank statement was last brought in: check it before chasing. */
  lastBankAt: string | null;
  /** When a reminder was last sent for this invoice, if ever. */
  lastChasedAt: string | null;
}

/** Days after a reminder before Flow presses again. */
export const CHASE_REST_DAYS = 7;

const aud = (cents: number) => (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" });
const long = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function lastChased(money: Money, invoiceId: string): string | null {
  return (money.db.prepare("SELECT MAX(at) AS at FROM events WHERE kind = 'chased' AND subject_id = ?").get(invoiceId) as { at: string | null }).at;
}

export function chaseDraft(money: Money, invoiceId: string): ChaseDraft {
  const inv = money.invoice(invoiceId);
  if (!inv) throw new MoneyError("no_invoice", "No such invoice.");
  if (inv.status !== "issued" || inv.balanceCents <= 0) throw new MoneyError("not_owed", "Nothing is owed on that invoice.");
  const client = money.client(inv.clientId)!;
  const s = money.settings();
  const account = inv.payToAccountId ? money.account(inv.payToAccountId) : null;
  const days = Math.max(0, inv.dueDate ? daysBetween(inv.dueDate, money.today()) : 0);
  const tone: ChaseDraft["tone"] = days > 45 ? "final" : days > 14 ? "firm" : "gentle";
  const participant = inv.participantName || client.participantName;
  const period = inv.serviceFrom || inv.serviceTo ? ` (${[inv.serviceFrom, inv.serviceTo].filter(Boolean).map((d) => long(d!)).join(" to ")})` : "";
  const due = inv.dueDate ? long(inv.dueDate) : "its due date";

  const opening = {
    gentle: `A quick reminder that invoice ${inv.number} for ${aud(inv.balanceCents)} was due on ${due}. If it's already on its way, thank you, and please ignore this.`,
    firm: `Invoice ${inv.number} for ${aud(inv.balanceCents)} is now ${days} days past its due date of ${due}. Could you let me know when it will be paid?`,
    final: `Invoice ${inv.number} for ${aud(inv.balanceCents)} is now ${days} days overdue (it was due on ${due}). Please arrange payment, or let me know if there's a problem with it so we can sort it out.`,
  }[tone];
  const lines = [
    `Hi ${client.contactName || "there"},`,
    "",
    opening,
    ...(participant ? ["", `It's for supports provided to ${participant}${period}.`] : []),
    ...(account ? ["", "It can be paid into:", account.accountName, `BSB ${account.bsb}   Account ${account.accountNumber}`, `Reference: ${inv.number}`] : []),
    "",
    "I can send the invoice again if that helps.",
    "",
    "Thanks,",
    s.businessName || "",
  ];
  const lastBank = (money.db.prepare("SELECT MAX(at) AS at FROM events WHERE kind = 'bank_imported'").get() as { at: string | null }).at;
  return {
    to: client.email,
    subject: `${tone === "gentle" ? "Reminder" : tone === "firm" ? "Overdue" : "Final reminder"}: invoice ${inv.number} from ${s.businessName || "us"}`,
    body: lines.join("\n").trimEnd(),
    tone, daysLate: days, lastBankAt: lastBank, lastChasedAt: lastChased(money, invoiceId),
  };
}

/** The operator says they've chased it (by email, phone, or otherwise). */
export function recordChased(money: Money, invoiceId: string, how: string): void {
  const inv = money.invoice(invoiceId);
  if (!inv) throw new MoneyError("no_invoice", "No such invoice.");
  const way = ["email", "phone", "other"].includes(how) ? how : "other";
  money.db.prepare("INSERT INTO events (at, actor, kind, subject_id, detail) VALUES (?, 'operator', 'chased', ?, ?)").run(new Date().toISOString(), invoiceId, way);
}
