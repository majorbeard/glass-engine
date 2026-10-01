// Pins @glass/client's public API: compares the type declarations tsup
// emits (dist/*.d.ts, so run the build first) with the committed snapshot
// in api/. Any difference fails, so every change to the published surface
// shows up in review. `--update` rewrites the snapshot.
//
// Private member names are dropped: TypeScript emits them (`private foo;`,
// no types) but consumers can't use them, and refactoring internals must
// not change the snapshot. The export list goes one name per line so a
// diff shows which export moved. See api/README.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entries = [
  { dist: "dist/index.d.ts", snapshot: "api/index.d.ts" },
  { dist: "dist/viewer/index.d.ts", snapshot: "api/viewer.d.ts" },
];
const update = process.argv.includes("--update");

function normalize(text) {
  return (
    text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((line) => !/^\s*private (readonly )?[\w$]+\??;$/.test(line))
      .map((line) => {
        const m = /^export \{ (.*) \};$/.exec(line);
        if (!m) return line;
        return `export {\n${m[1].split(", ").map((name) => `    ${name},`).join("\n")}\n};`;
      })
      .join("\n")
      .trimEnd() + "\n"
  );
}

let stale = false;
for (const { dist, snapshot } of entries) {
  const distPath = join(root, dist);
  const snapshotPath = join(root, snapshot);
  if (!existsSync(distPath)) {
    console.error(`${dist} is missing: run \`npm run build\` in packages/client first.`);
    process.exit(2);
  }
  const built = normalize(readFileSync(distPath, "utf8"));
  if (update) {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, built);
    console.log(`wrote ${snapshot}`);
    continue;
  }
  const pinned = existsSync(snapshotPath) ? readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n") : "";
  if (pinned === built) continue;

  stale = true;
  const before = new Set(pinned.split("\n"));
  const after = new Set(built.split("\n"));
  console.error(`\n${snapshot} does not match the build:`);
  for (const line of before) if (!after.has(line)) console.error(`  - ${line}`);
  for (const line of after) if (!before.has(line)) console.error(`  + ${line}`);
}

if (stale) {
  console.error(
    "\n@glass/client's public API changed. If that's intended, run `npm run api:update` in" +
      " packages/client, commit api/, and flag it for the glass-engine docs (see api/README.md).",
  );
  process.exit(1);
}
if (!update) console.log("@glass/client public API matches api/.");
