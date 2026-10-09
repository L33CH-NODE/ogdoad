// tsc doesn't copy non-TS files: bring the SQL migrations along into dist.
import { cpSync } from "node:fs";
cpSync("src/server/money/migrations", "dist/server/money/migrations", { recursive: true });
