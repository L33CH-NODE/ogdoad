// The membrane, on made-up books: names and details become stand-ins however they're written, the
// shapes with check digits are caught only when the digits agree, hints are flagged, and on the way back
// every stand-in is checked, and a real detail in a hire's message is an alarm.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { findPatterns, luhnOk, medicareOk, tfnOk } from "../membrane/patterns.js";
import { Membrane, digestOf } from "../membrane/membrane.js";
import { openMoneyDb } from "../money/db.js";
import { Money } from "../money/service.js";
import { standIn } from "../work/work.js";

function books() {
  const money = new Money(openMoneyDb(":memory:"));
  const acct = money.createAccount({ label: "Business", kind: "business", bankName: "Made-up Bank", accountName: "Quill and Fern Supports", bsb: "064-000", accountNumber: "12345678" }, "test");
  money.updateSettings({ businessName: "Quill and Fern Supports", abn: "51 824 753 556", contactEmail: "hello@quillfern.example", contactPhone: "0412 345 678", address: "7 Lantern Way, Brightwater QLD 4999", defaultAccountId: acct.id }, "test");
  const juniper = money.createClient({ name: "Juniper Ashgrove", participantName: "Juniper Ashgrove", email: "juniper.ashgrove@mail.example", phone: "0498 765 432", address: "12 Wattlebird Street, Seacliff QLD 4998", ndisNumber: "431234567" }, "test");
  const harbour = money.createClient({ name: "Tidewater Plan Managers Pty Ltd", contactName: "Oskar Brennholt", participantName: "Marlo Vance", email: "accounts@tidewater.example" }, "test");
  const will = money.createClient({ name: "Will Featherstone", participantName: "Will Featherstone" }, "test");
  return { money, m: new Membrane(money), juniper, harbour, will };
}

test("the check digits: TFN, Medicare and Luhn", () => {
  assert.equal(tfnOk("123456782"), true);
  assert.equal(tfnOk("123456789"), false);
  assert.equal(medicareOk("2123456701"), true);
  assert.equal(medicareOk("2123456711"), false);
  assert.equal(luhnOk("4111111111111111"), true);
  assert.equal(luhnOk("4111111111111112"), false);
});

test("shapes are caught only when the digits or the words around them agree", () => {
  const kinds = (t: string) => findPatterns(t).map((f) => `${f.kind}:${f.value}`);
  assert.deepEqual(kinds("Mail ops@example.org or call 0412 345 678 or (07) 5555 1234."), ["email:ops@example.org", "phone:0412 345 678", "phone:(07) 5555 1234"]);
  assert.deepEqual(kinds("ABN 51 824 753 556, not 51 824 753 557."), ["abn:51 824 753 556"]);
  // A plain nine-digit number that happens to pass mod 11 is left alone; with "TFN" before it, it isn't.
  assert.deepEqual(kinds("Order 123456782 shipped."), []);
  assert.deepEqual(kinds("TFN: 123456782"), ["tfn:123456782"]);
  assert.deepEqual(kinds("Medicare 2123 45670 1"), ["medicare:2123 45670 1"]);
  assert.deepEqual(kinds("Card 4111 1111 1111 1111, and 4111 1111 1111 1112."), ["card:4111 1111 1111 1111"]);
  assert.deepEqual(kinds("Pay BSB 064-000 acct 98765432."), ["bank:064-000", "bank:98765432"]);
  assert.deepEqual(kinds("Pay into 064-000 98765432 please"), ["bank:064-000 98765432"]);
  assert.deepEqual(kinds("NDIS number 430 000 001 on file"), ["ndis:430 000 001"]);
  assert.deepEqual(kinds("Visit 3/45 Banksia Road, Palm Cove QLD 4879 at noon."), ["address:3/45 Banksia Road, Palm Cove QLD 4879"]);
  assert.deepEqual(kinds("Post it to PO Box 77, Redfern NSW 2016."), ["address:PO Box 77, Redfern NSW 2016"]);
  assert.deepEqual(kinds("DOB: 03/04/1990, seen 5 minutes later"), ["dob:03/04/1990"]);
});

test("names from the books, however they're written", () => {
  const { m, juniper, harbour } = books();
  const j = standIn(juniper.id, "Juniper Ashgrove");
  // The calendar's stand-in, so a client reads the same everywhere.
  const out = m.out("Please draft a reminder for juniper ashgrove. Juniper's invoice is late; Mrs Ashgrove asked. Junipr Ashgrove again.");
  assert.equal(out.text, `Please draft a reminder for ${j}. ${j}'s invoice is late; ${j} asked. ${j} again.`);
  assert.ok(out.hold);

  const marlo = standIn(harbour.id, "Marlo Vance");
  const org = m.out("Tidewater Plan Managers asked about Marlo, and Oskar Brennholt called.");
  assert.match(org.text, new RegExp(`^C-\\d{4} asked about ${marlo}, and C-\\d{4} called\\.$`));
  assert.equal(new Set(org.changes.map((c) => c.token)).size, 3);
  // The same name gets the same stand-in next time.
  assert.equal(m.out("Tidewater Plan Managers Pty Ltd").text, org.changes[0].token);
});

test("a first name that's also a word counts only mid-sentence; a shared one is left for the operator", () => {
  const { m, money, will } = books();
  const w = standIn(will.id, "Will Featherstone");
  const out = m.out("Will you call Will tomorrow? Featherstone can wait.");
  assert.equal(out.text, `Will you call ${w} tomorrow? Featherstone can wait.`);
  assert.deepEqual(out.flags.map((f) => `${f.kind}:${f.text}`), ["maybe-name:Will", "maybe-name:Featherstone"]);

  money.createClient({ name: "Juniper Quell" }, "test");
  // A Membrane reads the books once (one request's worth): a new one sees the new client.
  const two = new Membrane(money).out("Juniper rang.");
  assert.equal(two.text, "Juniper rang.");
  assert.equal(two.flags[0].kind, "ambiguous");
  assert.ok(two.hold);
});

test("details: an email keeps its name letters, numbers in any spacing, the business itself", () => {
  const { m } = books();
  const out = m.out("Email juniper.ashgrove@mail.example or ring 0498765432. NDIS 431 234 567. Paid into 064-000 12345678 under Quill and Fern Supports, ABN 51824753556. She lives at 12 Wattlebird Street, Seacliff QLD 4998.");
  assert.deepEqual(out.changes.map((c) => c.kind), ["email", "phone", "ndis", "bank", "me", "abn", "address"]);
  assert.match(out.text, /^Email EMAIL-\d{4} or ring PHONE-\d{4}\. NDIS NDIS-\d{4}\. Paid into BANK-\d{4} under ME-\d{4}, ABN ABN-\d{4}\. She lives at ADDR-\d{4}\.$/);
  // +61 is the same phone.
  assert.equal(m.out("+61 498 765 432").text, out.changes[1].token);
});

test("hires' names and mentions are never touched; nothing to stand in sends straight", () => {
  const { m, money } = books();
  money.createClient({ name: "Scout Rennick" }, "test");
  const out = m.out("[@Scout](agent://a-scout) and Scout: please check the layout.", { protect: ["Scout"] });
  assert.equal(out.text, "[@Scout](agent://a-scout) and Scout: please check the layout.");
  assert.equal(out.hold, false);
  const plain = m.out("Make the pricing table responsive by Friday.");
  assert.equal(plain.text, plain.real);
  assert.equal(plain.hold, false);
});

test("hints are flagged, and enough of them together hold a message", () => {
  const { m } = books();
  const one = m.out("Plan a session for someone with autism.");
  assert.deepEqual(one.flags.map((f) => f.kind), ["condition"]);
  assert.equal(one.hold, false);
  const more = m.out("A 34-year-old with ADHD who lives in Kingscliff.");
  assert.deepEqual(more.flags.map((f) => f.kind), ["age", "condition", "place"]);
  assert.ok(more.warn);
  assert.ok(more.hold);
});

test("the way back: links, and what's wrong with them", () => {
  const { m, juniper } = books();
  const j = standIn(juniper.id, "Juniper Ashgrove");
  m.out("Remind Juniper Ashgrove.");
  const digits = j.slice(2);
  const reply = `Drafted for ${j}. Also C-1000, C ${digits} and C-48. Client ${digits} confirmed.`;
  const back = m.back(reply, { fromTeam: true });
  assert.deepEqual(back.links, { [j]: { real: "Juniper Ashgrove", kind: "who" } });
  const kinds = back.warnings.map((w) => `${w.kind}:${w.text}`);
  // C-1000 may exist by chance; only check it when it doesn't.
  if (!m.lookup(["C-1000"])["C-1000"]) assert.ok(kinds.includes("unknown:C-1000"));
  assert.ok(kinds.includes(`mangled:C ${digits}`));
  assert.ok(kinds.includes("mangled:C-48"));
  assert.ok(kinds.includes(`mangled:Client ${digits}`));
  assert.ok(!kinds.some((k) => k.startsWith("real:")));

  // A real name or a kept detail in a hire's message: it never had them.
  const leak = m.back("Spoke to Juniper Ashgrove at juniper.ashgrove@mail.example.", { fromTeam: true });
  assert.deepEqual(leak.warnings.map((w) => w.kind), ["real", "real"]);
  // The operator's own message is no alarm.
  assert.equal(m.back("Spoke to Juniper Ashgrove.").warnings.length, 0);
  assert.equal(m.relink(`Invoice for ${j}`), "Invoice for Juniper Ashgrove");
});

test("the digest changes with what's sent and what's flagged", () => {
  const a = digestOf([{ text: "Hi C-1234", flags: [] }]);
  assert.equal(a, digestOf([{ text: "Hi C-1234", flags: [] }]));
  assert.notEqual(a, digestOf([{ text: "Hi C-1235", flags: [] }]));
  assert.notEqual(a, digestOf([{ text: "Hi C-1234", flags: [{ start: 0, end: 2, text: "Hi", kind: "maybe-name", why: "" }] }]));
});

test("the model's pass: what it finds is flagged, never replaced, and a name the operator stands in is known from then on", async () => {
  const { m, money } = books();
  // A stand-in for the local model: it "finds" every capitalised two-word name, and one hire's name.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      const { text, protect } = JSON.parse(raw) as { text: string; protect: string[] };
      const spans = [...text.matchAll(/\b[A-Z][a-z]+ [A-Z][a-z]+\b|\bLedger\b/g)]
        .filter((x) => !protect.includes(x[0]))
        .map((x) => ({ label: "private_person", start: x.index!, end: x.index! + x[0].length, text: x[0], score: 0.99 }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ spans }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Juniper Ashgrove is in the books (replaced by them, so the model's find is no extra flag); Priya
    // Okonkwo isn't, so the model flags her; Ledger is a hire, protected.
    const out = await m.check("Juniper Ashgrove and Priya Okonkwo met Ledger.", { protect: ["Ledger"], backstop: url });
    assert.equal(out.model, "ok");
    assert.match(out.text, /^C-\d{4} and Priya Okonkwo met Ledger\.$/, "the model's find isn't replaced");
    assert.deepEqual(out.flags.map((f) => [f.kind, f.text, f.standIn]), [["model", "Priya Okonkwo", "who"]]);
    assert.ok(out.hold);

    // Off, or not answering: the books and patterns still stand, and the caller can say so.
    assert.equal((await m.check("Hello there.", { backstop: null })).model, "off");
    assert.equal((await m.check("Hello there.", { backstop: "http://127.0.0.1:9" })).model, "down");

    // The operator stands her in: she's matched like anyone in the books from then on, first name too.
    const token = m.standIn("who", "Priya Okonkwo");
    const again = new Membrane(money).out("Ask Priya Okonkwo, or just Priya.");
    assert.equal(again.text, `Ask ${token}, or just ${token}.`);
  } finally {
    server.close();
  }
});
