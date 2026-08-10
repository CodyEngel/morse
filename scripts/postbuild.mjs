#!/usr/bin/env node
// Make every declared `bin` executable after a build.
//
// `tsc` emits plain files at the process umask, so a bin that is only ever run
// through `npm test` looks fine and then fails the moment someone installs the
// package. Driving this off each package.json's `bin` map rather than a
// hard-coded path means a new package gets the same treatment for free — and
// means a bin declared but never emitted is a loud error here instead of a
// silent one at `npm i -g`.
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");

let touched = 0;
const missing = [];

for (const entry of readdirSync(packagesDir).sort()) {
  const manifestPath = join(packagesDir, entry, "package.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin = manifest.bin;
  if (!bin) continue;

  const targets = typeof bin === "string" ? [bin] : Object.values(bin);
  for (const target of targets) {
    const path = join(packagesDir, entry, target);
    if (!existsSync(path)) {
      missing.push(`${manifest.name}: ${target}`);
      continue;
    }
    chmodSync(path, 0o755);
    touched++;
  }
}

if (missing.length > 0) {
  console.error("Declared `bin` entries with nothing built at that path:");
  for (const entry of missing) console.error(`  ${entry}`);
  process.exit(1);
}

if (process.env.MORSE_POSTBUILD_QUIET !== "1") {
  console.log(`postbuild: made ${touched} bin${touched === 1 ? "" : "s"} executable`);
}
