// Ogdoad's patches to the pinned runtime's dependencies. Runs after `npm install` (postinstall) and
// is safe to run again: each patch checks for its marker first. A patch whose target text has moved
// (a dependency changed) is reported loudly but doesn't fail the install.
//   node patches/apply.mjs [engineDir]   (the folder holding node_modules; this runtime/ by default)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2] ? resolve(process.argv[2]) : join(dirname(fileURLToPath(import.meta.url)), "..");

const PATCHES = [
  {
    name: "embedded-postgres: stop Postgres cleanly on Windows",
    // Upstream stops Postgres on Windows with `taskkill /f /t`, so every shutdown kills the database
    // and the next start runs crash recovery. pg_ctl's fast shutdown checkpoints and exits cleanly;
    // taskkill stays as the fallback if pg_ctl can't do it.
    // The server loads the top-level copy; @paperclipai/db carries its own.
    files: ["node_modules/embedded-postgres/dist/index.js", "node_modules/@paperclipai/db/node_modules/embedded-postgres/dist/index.js"],
    marker: "OGDOAD PATCH: pg_ctl stop",
    find: `                    // Actually kill the process using the Windows taskkill command
                    spawn('taskkill', ['/pid', this.process.pid.toString(), '/f', '/t']);`,
    replace: `                    // OGDOAD PATCH: pg_ctl stop. A fast shutdown checkpoints and exits cleanly; taskkill only
                    // if pg_ctl fails. (Upstream force-kills here, leaving the cluster to crash recovery.)
                    const pid = this.process.pid.toString();
                    const forceKill = () => spawn('taskkill', ['/pid', pid, '/f', '/t']);
                    bin.then(({ pg_ctl }) => {
                        const stopper = spawn(pg_ctl, ['stop', '-D', this.options.databaseDir, '-m', 'fast', '-w', '-t', '60'], { stdio: 'ignore', windowsHide: true });
                        stopper.on('exit', (code) => { if (code !== 0) forceKill(); });
                        stopper.on('error', forceKill);
                    }, forceKill);`,
  },
];

let failed = 0;
for (const p of PATCHES) {
  for (const file of p.files) {
    const path = join(root, file);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      console.warn(`[ogdoad patches] SKIPPED ${p.name}: ${file} not found`);
      failed++;
      continue;
    }
    if (text.includes(p.marker)) {
      console.log(`[ogdoad patches] already applied: ${p.name} (${file})`);
      continue;
    }
    if (!text.includes(p.find)) {
      console.warn(`[ogdoad patches] NOT APPLIED ${p.name}: the code it patches has changed. Review ${file}.`);
      failed++;
      continue;
    }
    writeFileSync(path, text.replace(p.find, p.replace), "utf8");
    console.log(`[ogdoad patches] applied: ${p.name} (${file})`);
  }
}
if (failed) console.warn(`[ogdoad patches] ${failed} patch(es) need attention.`);
