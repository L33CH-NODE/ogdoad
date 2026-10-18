// Loaded into a server Horos runs (NODE_OPTIONS=--require), so Horos can ask for the server's own
// graceful shutdown without console signals. On Windows a process started in a new process group
// ignores Ctrl+C, and so do its children, so Ctrl+C can't be relied on to reach a background server.
// When the stop file appears, the server gets SIGINT from inside, exactly as if Ctrl+C had reached it,
// and runs its own ordered shutdown (Nous stops handing out jobs and closes its store; the app closes
// the books). It's an event, not a real signal: a server with no SIGINT listener never hears it, and
// Horos kills it once its patience runs out. So every server Horos keeps listens for SIGINT.
"use strict";

const fs = require("node:fs");

const stopFile = process.env.OGDOAD_STOP_FILE;

// Arm only in the server's own process. Processes it spawns (plugin workers) inherit the environment,
// so mark the owner and take the hook out of NODE_OPTIONS before any child starts.
if (stopFile && !process.env.OGDOAD_STOP_HOOK_PID) {
  process.env.OGDOAD_STOP_HOOK_PID = String(process.pid);
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS || "").replace(/--require\s+("[^"]*graceful-hook\.cjs"|\S*graceful-hook\.cjs)/, "").trim();
  try {
    fs.unlinkSync(stopFile); // a stale request from a previous run
  } catch {}
  const timer = setInterval(() => {
    if (!fs.existsSync(stopFile)) return;
    clearInterval(timer);
    try {
      fs.unlinkSync(stopFile);
    } catch {}
    process.emit("SIGINT", "SIGINT");
  }, 500);
  timer.unref();
}
