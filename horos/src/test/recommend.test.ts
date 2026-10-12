import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendSophia, type Candidate } from "../sophia/recommend.js";

const GB = 1024 ** 3;
const harness = (id: string, name: string, privacy: Candidate["privacy"] = "cloud"): Candidate => ({ kind: "harness", id, name, privacy });
const model = (id: string, gb: number): Candidate => ({ kind: "local-model", id, name: `${id} (ollama)`, privacy: "local", sizeBytes: gb * GB, runtime: "ollama" });

const everything = [
  harness("gemini", "Gemini CLI"), harness("grok", "grok CLI"), harness("codex", "Codex CLI"), harness("claude", "Claude Code"),
  harness("opencode", "opencode", "either"), model("qwen3.5:4b", 2.6), model("qwen3.5:9b", 5.6), model("qwen3:32b", 19),
];

test("private never picks the cloud: the biggest local model that stays quick on a shared card", () => {
  const rec = recommendSophia("private", everything)!;
  assert.equal(rec.pick.id, "qwen3.5:9b");
  assert.match(rec.why, /never leaves|stays on this machine/);
  // Only big models: the smallest of them, said plainly.
  assert.equal(recommendSophia("private", [harness("claude", "Claude Code"), model("qwen3:32b", 19), model("llama:70b", 40)])!.pick.id, "qwen3:32b");
  // opencode and Hermes can reach the cloud too: never recommended as private (the operator can still choose them).
  assert.equal(recommendSophia("private", [harness("claude", "Claude Code"), harness("opencode", "opencode", "either")]), null);
});

test("power ranks Claude Code, then Codex, grok and Gemini; then what can run locally", () => {
  assert.equal(recommendSophia("power", everything)!.pick.id, "claude");
  assert.equal(recommendSophia("power", everything.filter((c) => c.id !== "claude"))!.pick.id, "codex");
  assert.equal(recommendSophia("power", [harness("gemini", "Gemini CLI"), harness("grok", "grok CLI")])!.pick.id, "grok");
  assert.equal(recommendSophia("power", [harness("hermes", "Hermes", "either"), model("qwen3.5:9b", 5.6)])!.pick.id, "hermes");
  assert.equal(recommendSophia("power", [model("qwen3.5:9b", 5.6)])!.pick.id, "qwen3.5:9b");
  assert.equal(recommendSophia("power", []), null);
});

test("balanced plans in the cloud and says the membrane keeps the company's data here", () => {
  const rec = recommendSophia("balanced", everything)!;
  assert.equal(rec.pick.id, "claude");
  assert.match(rec.why, /membrane/);
});
