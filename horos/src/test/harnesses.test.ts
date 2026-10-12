import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveCommand } from "../harnesses.js";

test("a command is found on PATH, and a full path is taken as it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "horos-resolve-"));
  const name = process.platform === "win32" ? "tool.exe" : "tool";
  writeFileSync(join(dir, name), "");
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };

  assert.equal(resolveCommand("tool", env)?.path, join(dir, name));
  // The installer hands Horos the exact Node it ran with, which needn't be on PATH at all.
  assert.equal(resolveCommand(process.execPath, { PATH: "" })?.file, process.execPath);
  assert.equal(resolveCommand(join(dir, "missing.exe"), env), null);
  assert.equal(resolveCommand("missing", env), null);
});
