/**
 * Internal link check over the built site.
 *
 * Astro will happily build a page whose links point at nothing, and a docs site
 * assembled from a README is mostly cross-references — so the links are checked
 * against what was actually emitted rather than trusted. It runs as part of
 * `npm run build` (and therefore `npm run docs:build` at the repository root)
 * because a broken link found at deploy time is a broken link that shipped.
 *
 * Anchors are checked too: renaming a heading is the common way a working link
 * turns into one that lands on the right page and the wrong place.
 *
 *   node scripts/check-links.mjs dist
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");

if (!existsSync(dist)) {
  console.error(`No build output at ${dist}. Run \`npm run build\` first.`);
  process.exit(1);
}

/** Every .html file under the build output. */
function pages(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...pages(path));
    else if (entry.endsWith(".html")) found.push(path);
  }
  return found;
}

/** Where a site-absolute href would have been written, if it exists at all. */
function target(pathname) {
  const clean = pathname.replace(/\/+$/, "");
  for (const candidate of [join(dist, clean), join(dist, `${clean}.html`), join(dist, clean, "index.html")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

const html = pages(dist);
const broken = [];
let checked = 0;

for (const page of html) {
  const body = readFileSync(page, "utf8");
  const where = relative(dist, page);
  for (const match of body.matchAll(/href="([^"]*)"/g)) {
    const href = match[1];
    // Only internal, site-absolute links. Protocol-relative, external, mailto,
    // and same-page anchors are somebody else's problem.
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const [pathname, hash] = href.split("#");
    checked++;
    const file = target(pathname);
    if (!file) {
      broken.push(`${href} → no such page (linked from ${where})`);
      continue;
    }
    if (!hash) continue;
    const dest = readFileSync(file, "utf8");
    if (!dest.includes(`id="${hash}"`) && !dest.includes(`name="${hash}"`)) {
      broken.push(`${href} → page exists, no #${hash} on it (linked from ${where})`);
    }
  }
}

if (broken.length) {
  console.error(`Broken internal links (${broken.length}):\n`);
  for (const entry of broken) console.error(`  ${entry}`);
  console.error("");
  process.exit(1);
}

console.log(`links: ${checked} internal links across ${html.length} pages, all resolve`);
