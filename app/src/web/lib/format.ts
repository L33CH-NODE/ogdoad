// Money and dates the Australian way.

export function aud(cents: number, opts: { cents?: boolean } = {}): string {
  const showCents = opts.cents ?? true;
  return (cents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: showCents ? 2 : 0, maximumFractionDigits: showCents ? 2 : 0 });
}

/** "$1,234.50" or "1234.5" typed by a person, to cents. NaN when it isn't an amount. */
export function parseAud(text: string): number {
  const cleaned = text.replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "." || cleaned === "-") return NaN;
  return Math.round(Number(cleaned) * 100);
}

export function shortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function ago(isoTime: string): string {
  const s = Math.round((Date.now() - Date.parse(isoTime)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const BUCKET_LABEL: Record<string, string> = {
  draft: "Draft", void: "Void", paid: "Paid", current: "Not due", "1-30": "1–30 days late", "31-60": "31–60 days late", "61-90": "61–90 days late", "90+": "90+ days late",
};
