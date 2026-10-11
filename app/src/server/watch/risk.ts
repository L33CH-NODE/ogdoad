// What a hire wants to do, sorted into kinds of risk. This is the smoke alarm, not the lock: it says
// what a request looks like (deleting, sending something out, spending, touching secrets), and the
// operator decides. Rules first: they're plain, testable and fast. A local model can add a second
// opinion later, but it never answers for the operator either.

import type { Ask } from "./prompt.js";

export type RiskKind = "destructive" | "outward" | "spending" | "investing" | "secrets" | "hiring" | "installs" | "web" | "writes" | "runs" | "reads";

/** Kinds that always wait for the operator, whatever the policy says: the floor under the policy. */
export const ALWAYS_ASK: readonly RiskKind[] = ["destructive", "outward", "spending", "investing", "secrets", "hiring"];

export const RISK_WORD: Record<RiskKind, string> = {
  destructive: "deletes or overwrites", outward: "sends something out", spending: "spends money", investing: "invests or trades", secrets: "touches secrets",
  hiring: "starts another agent", installs: "installs software", web: "reads the web", writes: "changes files", runs: "runs a command", reads: "reads files",
};

/** The same, as what a hire "wants to" do: for a card's title. */
export const RISK_VERB: Record<RiskKind, string> = {
  destructive: "delete or overwrite something", outward: "send something out", spending: "spend money", investing: "invest or trade", secrets: "touch secrets",
  hiring: "start another agent", installs: "install software", web: "read the web", writes: "change files", runs: "run a command", reads: "read files",
};

export interface Risk { kinds: RiskKind[]; reasons: Array<{ kind: RiskKind; why: string }>; high: boolean }

const RULES: Array<{ kind: RiskKind; re: RegExp; why: string }> = [
  // Destructive.
  { kind: "destructive", re: /\brm\s+(-\w*\s+)*\S|\brmdir\b|\bdel\s+\S|\bRemove-Item\b|\brd\s+\/s\b|\bshred\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:/i, why: "deletes files" },
  { kind: "destructive", re: /\bgit\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s|restore\s|branch\s+-D|push\s+.*(--force|-f\b)|stash\s+(drop|clear)|filter-(branch|repo))/i, why: "throws away git history or changes" },
  { kind: "destructive", re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/i, why: "deletes database records" },
  { kind: "destructive", re: /\b(kill\s+-9|taskkill\s+\/f|Stop-Process|pkill|killall)\b/i, why: "kills processes" },
  { kind: "destructive", re: /\bchmod\s+-R\b|\bchown\s+-R\b|>\s*\/dev\/sd|\boverwrite\b/i, why: "overwrites or changes permissions wholesale" },
  // Outward.
  { kind: "outward", re: /\bgit\s+push\b|\bgh\s+(pr|release|issue|repo|gist)\s+(create|edit|merge|delete|comment)|\bgh\s+api\s+.*-X\s*(POST|PUT|PATCH|DELETE)/i, why: "publishes to GitHub" },
  { kind: "outward", re: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgem\s+push\b/i, why: "publishes a package" },
  { kind: "outward", re: /\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|--form|-F\s)|\bwget\b[^\n]*--post|Invoke-(RestMethod|WebRequest)[^\n]*-Method\s+(Post|Put|Patch|Delete)/i, why: "sends data to a web address" },
  { kind: "outward", re: /\b(scp|rsync|sftp)\b[^\n]*\S+:|\bssh\s+\S+@?\S+|\btailscale\s+(file\s+cp|funnel|serve)\b/i, why: "copies to or reaches another machine" },
  { kind: "outward", re: /\b(sendmail|mailx?|send[-_ ]?(email|message|mail))\b|hooks\.slack\.com|discord(app)?\.com\/api\/webhooks|api\.telegram\.org/i, why: "sends a message" },
  { kind: "outward", re: /\b(vercel|netlify)\s+(deploy|--prod)|\bwrangler\s+(deploy|publish)|\bfly\s+deploy|\bfirebase\s+deploy|\bkubectl\s+(apply|delete)|\bterraform\s+(apply|destroy)/i, why: "deploys something public" },
  // Money.
  { kind: "spending", re: /\bstripe\b|\bpaypal\b|\bcheckout\b|\bpurchase\b|\bpayment\b|\bcharge\b|\bbuy\b|\bsubscribe\b|\/ogdoad\/money\/[^\s]*\/(issue|pay)|\baws\s+\S+\s+(run-instances|create-\S+)|\bgcloud\s+\S+.*\bcreate\b/i, why: "may spend money" },
  { kind: "investing", re: /\b(trade|trading|broker|brokerage|binance|coinbase|kraken|alpaca|ibkr|interactive brokers|place[_ -]?order|limit order|market order|crypto|bitcoin|ethereum)\b/i, why: "may invest or trade" },
  // Secrets.
  { kind: "secrets", re: /(^|[\s/\\'"])\.env(\.\w+)?\b|\bid_(rsa|ed25519|ecdsa)\b|\.pem\b|\.p12\b|\.pfx\b|\.ssh[\\/]|credentials?\b|\bsecrets?\b|\btokens?\b|\bpasswords?\b|\bpasswd\b|\bkeychain\b|\bprintenv\b|\baws\s+configure\b|\bgh\s+auth\s+token\b|\.ogdoad[\\/]|horos\.token|money\.db|\.vault\b/i, why: "reads or handles secrets or Ogdoad's own data" },
  // Other agents.
  { kind: "hiring", re: /\/v1\/hires\b|\bhoros\s+(hire|spawn)\b|\bclaude\s+(-p|--print)\b|\bcodex\s+exec\b|\bgemini\s+-p\b|\bogdoad\s+hire\b/i, why: "starts another agent" },
  // Lesser kinds.
  { kind: "installs", re: /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\buv\s+(pip\s+install|add)\b|\bcargo\s+(install|add)\b|\bapt(-get)?\s+install\b|\bwinget\s+install\b|\bchoco\s+install\b|\bbrew\s+install\b|\bnpx\s+\S/i, why: "installs or runs downloaded code" },
  { kind: "web", re: /\bhttps?:\/\/\S+|\bweb\s*fetch\b|\bfetch\b.*\burl\b|\bweb\s*search\b|\bwebsite\b|\bbrowse\b|\bopen\s+(a\s+)?(url|link|web\s*page)\b/i, why: "reads the web (the address itself leaves)" },
  { kind: "writes", re: /\bmake this edit\b|\bedit file\b|\bcreate file\b|\bwrite\b|\bmkdir\b|\btouch\b|\bmv\s|\bcp\s|\bMove-Item\b|\bCopy-Item\b|\bSet-Content\b|[^\s=\-<>&|][ \t]*>>?[ \t]*[\w./~"'$]/i, why: "changes files" },
  { kind: "reads", re: /^\s*(ls|dir|cat|type|head|tail|less|grep|rg|find|fd|wc|stat|pwd|echo|which|where|Get-ChildItem|Get-Content|Select-String)\b|\bgit\s+(status|log|diff|show|branch)\b|\bread file\b/im, why: "reads files" },
];

/** The kinds of risk in what a hire asks to do, each with why. A command that matches nothing is "runs". */
export function classify(ask: Pick<Ask, "title" | "action" | "question">): Risk {
  const text = [ask.title ?? "", ask.action, ask.question].join("\n");
  const reasons: Risk["reasons"] = [];
  for (const r of RULES) {
    if (r.re.test(text) && !reasons.some((x) => x.kind === r.kind && x.why === r.why)) reasons.push({ kind: r.kind, why: r.why });
  }
  const kinds = [...new Set(reasons.map((r) => r.kind))];
  // Reading is only "just reading" when nothing else is going on.
  const plain = kinds.length > 1 ? kinds.filter((k) => k !== "reads") : kinds;
  const final: RiskKind[] = plain.length ? plain : ["runs"];
  return { kinds: final, reasons: reasons.filter((r) => final.includes(r.kind)), high: final.some((k) => ALWAYS_ASK.includes(k)) };
}
