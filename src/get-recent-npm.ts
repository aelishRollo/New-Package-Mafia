/**
 * Find "truly new" npm packages:
 *  - have exactly ONE published version
 *  - that version was published within the last N days (default 7)
 *
 * Behavior:
 *  - Prints human-readable info to the terminal (like the old version).
 *  - Also writes a CSV file `newest.csv` in the current directory with:
 *      name,description,publishedAt,npmUrl
 *
 * Requires: Node 18+ (for global fetch).
 *
 * Usage:
 *   node find-new-npm-packages.mjs [changesLimit] [maxResults] [daysBack]
 *
 *   changesLimit = how many recent changes to inspect (default 200)
 *   maxResults   = how many "new" packages to print/save (default 30)
 *   daysBack     = how many days back to consider "new" (default 7)
 */

import fs from "node:fs";

const REGISTRY_CHANGES_URL = "https://replicate.npmjs.com/registry/_changes";
const REGISTRY_DOC_URL_BASE = "https://registry.npmjs.org";
const NPM_PACKAGE_URL_BASE = "https://www.npmjs.com/package";

if (typeof fetch === "undefined") {
  console.error("This script requires Node 18+ (global fetch).");
  process.exit(1);
}

function parseNumber(val, fallback) {
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const changesLimit = parseNumber(process.argv[2] ?? "", 200);
const maxResults   = parseNumber(process.argv[3] ?? "", 30);
const daysBack     = parseNumber(process.argv[4] ?? "", 7);
const concurrency  = 10; // parallel metadata fetches

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/**
 * Fetch a slice of the npm changes feed and return unique package IDs.
 */
async function getRecentPackageNames(limit) {
  const url = new URL(REGISTRY_CHANGES_URL);
  url.searchParams.set("descending", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`_changes request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const seen = new Set();
  const names = [];

  for (const row of data.results ?? []) {
    const id = row.id;
    if (!id) continue;
    if (id.startsWith("_design/")) continue; // skip internal docs

    if (!seen.has(id)) {
      seen.add(id);
      names.push(id);
    }
  }

  return names;
}

/**
 * Return info if package:
 * - has exactly one version
 * - that version was published within `daysBack` days
 * Otherwise returns null.
 */
async function getIfSingleVersionAndRecent(pkgName, daysBack) {
  const url = `${REGISTRY_DOC_URL_BASE}/${encodeURIComponent(pkgName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${pkgName}: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = await res.json();
  const versionsObj = data.versions || {};
  const versionNames = Object.keys(versionsObj);

  if (versionNames.length !== 1) {
    return null;
  }

  const onlyVersion = versionNames[0];
  const timeMap = data.time || {};
  const publishedStr = timeMap[onlyVersion] || timeMap.created;

  if (!publishedStr) {
    return null;
  }

  const publishedDate = new Date(publishedStr);
  if (Number.isNaN(publishedDate.getTime())) {
    return null;
  }

  const ageMs = now - publishedDate.getTime();
  const maxAgeMs = daysBack * MS_PER_DAY;

  if (ageMs < 0 || ageMs > maxAgeMs) {
    // From the future (clock skew) or older than our window
    return null;
  }

  // Prefer top-level description, then version-specific description.
  let description =
    data.description ||
    (versionsObj[onlyVersion] && versionsObj[onlyVersion].description) ||
    "";

  // Normalize newlines/tabs so they don't blow up CSV readability
  description = description.replace(/[\r\n\t]+/g, " ").trim();

  const npmUrl = `${NPM_PACKAGE_URL_BASE}/${encodeURIComponent(pkgName)}`;

  return {
    name: pkgName,
    version: onlyVersion,
    description,
    publishedAt: publishedDate,
    npmUrl,
  };
}

/**
 * Escape a value for CSV:
 * - Wrap in double quotes if it contains comma, quote, newline, or tab
 * - Escape internal quotes by doubling them
 */
function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n\t]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main() {
  console.log(
    `Inspecting latest ${changesLimit} changes for packages with exactly 1 version, ` +
    `published within the last ${daysBack} day(s)...`
  );

  const names = await getRecentPackageNames(changesLimit);
  console.log(`Got ${names.length} unique package IDs from changes feed.`);

  const results = [];
  let index = 0;

  async function worker(workerId) {
    while (index < names.length && results.length < maxResults) {
      const currentIndex = index++;
      const name = names[currentIndex];

      try {
        const info = await getIfSingleVersionAndRecent(name, daysBack);
        if (info) {
          results.push(info);

          const label = `NEW[${results.length}]`;
          const publishedStr = info.publishedAt.toISOString();

          // Human-readable terminal output (old behavior)
          console.log(`${label.padEnd(8)} ${info.name}@${info.version}`);
          console.log(`          published: ${publishedStr}`);
          if (info.description) {
            console.log(`          desc: ${info.description}`);
          }
          console.log(`          url:  ${info.npmUrl}`);
          console.log();
        }
      } catch (err) {
        console.error(`Error checking ${name}:`, err);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  console.log(
    `\nSummary: packages that appear to be 'brand new' (only one version, <= ${daysBack} day(s) old):`
  );

  if (results.length === 0) {
    console.log("  (none found in this slice of the changes feed)");
    console.log(
      "Try increasing changesLimit or daysBack, e.g.:\n" +
      "  node find-new-npm-packages.mjs 2000 50 14"
    );
  } else {
    for (const info of results) {
      const publishedStr = info.publishedAt.toISOString();
      console.log(
        `- ${info.name}@${info.version} (published ${publishedStr})` +
        (info.description ? ` — ${info.description}` : "")
      );
    }
  }

  // ---- Write CSV file ----
  const csvHeader = ["name", "description", "publishedAt", "npmUrl"]
    .map(csvEscape)
    .join(",");

  const csvRows = results.map((info) =>
    [
      info.name,
      info.description,
      info.publishedAt.toISOString(),
      info.npmUrl,
    ]
      .map(csvEscape)
      .join(",")
  );

  const csvContent = [csvHeader, ...csvRows].join("\n");

  fs.writeFileSync("newest.csv", csvContent, "utf8");
  console.log(`\nWrote ${results.length} row(s) to newest.csv`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
