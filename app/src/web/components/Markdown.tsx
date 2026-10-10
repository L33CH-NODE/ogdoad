// A small Markdown reader for the hires' messages: paragraphs, headings, lists, fenced code, bold,
// inline code and web links. Everything is rendered as text nodes (never as HTML), so a message
// can't inject anything into the page.
//
// Stand-ins (C-4821) read as who they stand for, marked, when the page knows (links): the real name
// is put back on the operator's screen only. asSent shows them as the team saw them instead.

import type { ReactNode } from "react";

import { TOKEN_SOURCE } from "../../shared/standins";
import type { Links } from "../lib/api";

interface Relink { links?: Links; asSent?: boolean }

// A mention in the engine's own form, [@Name](agent://id), shows as a name chip; a stand-in, as who it is.
const INLINE = new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|\\[@[^\\]]+\\]\\(agent:\\/\\/[^)\\s]+\\)|\\[[^\\]]+\\]\\((https?:\\/\\/[^)\\s]+)\\)|${TOKEN_SOURCE})`, "g");

/** A stand-in: the real detail with its stand-in on hover, or the stand-in with the real one on hover. */
export function StandIn({ token, links, asSent }: { token: string } & Relink) {
  const real = links?.[token]?.real;
  if (!real) return <span className="standin unknown" title="Not anyone in your books">{token}</span>;
  return asSent
    ? <span className="standin sent" title={real}>{token}</span>
    : <span className="standin" title={`The team saw this as ${token}`}>{real}</span>;
}

/** Plain text with its stand-ins read back (a title, a crossing). */
export function Relinked({ text, links, asSent }: { text: string } & Relink) {
  const out: ReactNode[] = [];
  const re = new RegExp(TOKEN_SOURCE, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<StandIn key={m.index} token={m[0]} links={links} asSent={asSent} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function inline(text: string, key: string, relink: Relink): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{inline(t.slice(2, -2), `${key}-${i++}`, relink)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[@")) out.push(<span key={`${key}-${i++}`} className="mention">@{/^\[@([^\]]+)\]/.exec(t)![1]}</span>);
    else if (t.startsWith("[")) out.push(<a key={`${key}-${i++}`} href={m[2]} target="_blank" rel="noreferrer noopener">{/^\[([^\]]+)\]/.exec(t)![1]}</a>);
    else out.push(<StandIn key={`${key}-${i++}`} token={t} {...relink} />);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, renderFence, links, asSent }: { text: string; renderFence?: (lang: string, body: string, key: string) => ReactNode | null } & Relink) {
  const relink: Relink = { links, asSent };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const key = `b${n++}`;
      blocks.push(renderFence?.(fence[1], body.join("\n"), key) ?? <pre key={key} className="md-code">{body.join("\n")}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<strong key={`b${n++}`} className="md-h">{inline(heading[2], `h${n}`, relink)}</strong>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
      const key = `b${n++}`;
      const lis = items.map((it, k) => <li key={k}>{inline(it, `${key}-${k}`, relink)}</li>);
      blocks.push(ordered ? <ol key={key}>{lis}</ol> : <ul key={key}>{lis}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    const key = `b${n++}`;
    blocks.push(<p key={key}>{inline(para.join(" "), key, relink)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
