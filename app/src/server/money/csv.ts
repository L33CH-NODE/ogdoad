// A small RFC 4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a BOM
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Rows as objects keyed by header label (first occurrence wins when a label repeats). */
export function csvRecords(text: string): Array<{ get(label: string): string; at(index: number): string }> {
  const [header, ...rows] = parseCsv(text);
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    if (!index.has(key)) index.set(key, i);
  });
  return rows.map((r) => ({
    get: (label: string) => {
      const i = index.get(label.toLowerCase());
      return i === undefined ? "" : (r[i] ?? "").trim();
    },
    at: (i: number) => (r[i] ?? "").trim(),
  }));
}
