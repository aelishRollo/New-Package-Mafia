/**
 * Find "truly new" npm packages:
 *  - whose FIRST version was published within the last N days (default 7)
 *  - with at least two versions (intentional noise filter)
 *  - optionally filter by description search terms
 *  - optionally filter by minimum JavaScript lines
 *
 * The npm changes feed is a forward replication cursor. It does not support
 * backward paging through history. For stateless weekly scans we approximate
 * the starting sequence by probing older sequence numbers, then walk forward to
 * a frozen head sequence.
 */

import { matchesSearch, parseSearchTerms } from "./description-filter.js";
import { countJsLinesInPackage } from "./js-lines-counter.js";
import type { GetRecentPackagesOptions, PackageInfo } from "./package-types.js";

const REGISTRY_CHANGES_URL = "https://replicate.npmjs.com/registry/_changes";
const REGISTRY_DOC_URL_BASE = "https://registry.npmjs.org";
const NPM_PACKAGE_URL_BASE = "https://www.npmjs.com/package";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PROBE_LIMIT = 20;
const PROBE_DOCS = 6;
const PROBE_ITERATIONS = 12;
const INITIAL_SEQ_STEP = 100_000;
const MAX_SEQ_STEP = 100_000_000;

interface ChangeRow {
  seq: number;
  id: string;
}

interface ChangesResponse {
  results: ChangeRow[];
  last_seq: string | number;
}

interface NpmPackageDocument {
  description?: string;
  versions?: Record<string, { description?: string; bin?: unknown }>;
  time?: Record<string, string>;
  "dist-tags"?: { latest?: string };
}

function changesUrl(params: Record<string, string | number | boolean>): URL {
  const url = new URL(REGISTRY_CHANGES_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchJson<T>(url: string | URL): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} request failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function fetchPackageDocument(
  pkgName: string
): Promise<NpmPackageDocument | null> {
  const url = `${REGISTRY_DOC_URL_BASE}/${encodeURIComponent(pkgName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${pkgName}: ${res.status} ${res.statusText}`);
    return null;
  }
  return (await res.json()) as NpmPackageDocument;
}

async function fetchHeadSeq(): Promise<number> {
  const data = await fetchJson<ChangesResponse>(
    changesUrl({ descending: true, limit: 1 })
  );
  const rowSeq = data.results?.[0]?.seq;
  const seq = typeof rowSeq === "number" ? rowSeq : Number(data.last_seq);
  if (!Number.isFinite(seq)) {
    throw new Error("Could not read npm _changes head sequence");
  }
  return seq;
}

async function sampleModifiedTimeAfterSeq(seq: number): Promise<number | null> {
  const data = await fetchJson<ChangesResponse>(
    changesUrl({ since: Math.max(0, Math.floor(seq)), limit: PROBE_LIMIT })
  );
  const times: number[] = [];

  for (const row of data.results.slice(0, PROBE_DOCS)) {
    if (!row.id || row.id.startsWith("_design/")) continue;
    const doc = await fetchPackageDocument(row.id);
    const modified = doc?.time?.modified;
    if (!modified) continue;
    const time = Date.parse(modified);
    if (Number.isFinite(time)) {
      times.push(time);
    }
  }

  if (times.length === 0) {
    return null;
  }

  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

async function findApproximateStartSeq(
  headSeq: number,
  daysBack: number,
  now: number
): Promise<number> {
  const safetyDays = Math.max(1, Math.ceil(daysBack * 0.25));
  const target = now - (daysBack + safetyDays) * MS_PER_DAY;

  console.log(
    `Estimating npm _changes start sequence with ${safetyDays} safety day(s)...`
  );

  let high = headSeq;
  let step = INITIAL_SEQ_STEP;
  let low = Math.max(0, headSeq - step);
  let lowTime = await sampleModifiedTimeAfterSeq(low);

  while (low > 0 && lowTime !== null && lowTime > target && step < MAX_SEQ_STEP) {
    high = low;
    step *= 2;
    low = Math.max(0, headSeq - step);
    lowTime = await sampleModifiedTimeAfterSeq(low);
  }

  if (lowTime === null) {
    console.log("Could not estimate old sequence time; scanning from sequence 0.");
    return 0;
  }

  if (lowTime > target) {
    console.log("Could not find a sequence old enough; scanning from sequence 0.");
    return 0;
  }

  for (let i = 0; i < PROBE_ITERATIONS && high - low > 1; i++) {
    const mid = Math.floor((low + high) / 2);
    const midTime = await sampleModifiedTimeAfterSeq(mid);
    if (midTime === null) {
      high = mid;
    } else if (midTime <= target) {
      low = mid;
    } else {
      high = mid;
    }
  }

  console.log(`Estimated npm _changes start sequence: ${low}`);
  return low;
}

async function collectChangedPackageNames(
  startSeq: number,
  headSeq: number,
  limit: number,
  maxPages: number
): Promise<{ names: string[]; rowsSeen: number; pagesSeen: number }> {
  const seen = new Set<string>();
  const names: string[] = [];
  let since = Math.max(0, Math.floor(startSeq));
  let rowsSeen = 0;
  let pagesSeen = 0;

  while (since < headSeq && pagesSeen < maxPages) {
    pagesSeen++;
    console.log(
      `\nFetching npm _changes page ${pagesSeen} from seq ${since} to frozen head ${headSeq}...`
    );

    const data = await fetchJson<ChangesResponse>(changesUrl({ since, limit }));
    const rows = data.results ?? [];
    if (rows.length === 0) {
      break;
    }

    let advanced = false;
    for (const row of rows) {
      if (typeof row.seq !== "number") continue;
      if (row.seq > headSeq) {
        since = headSeq;
        break;
      }

      rowsSeen++;
      since = row.seq;
      advanced = true;

      if (!row.id || row.id.startsWith("_design/")) continue;
      if (!seen.has(row.id)) {
        seen.add(row.id);
        names.push(row.id);
      }
    }

    console.log(
      `Got ${rows.length} change row(s); ${names.length} unique package ID(s) so far.`
    );

    if (!advanced) {
      break;
    }
  }

  return { names, rowsSeen, pagesSeen };
}

function packageInfoFromDocument(
  pkgName: string,
  data: NpmPackageDocument,
  daysBack: number,
  now: number
): PackageInfo | null {
  const versionsObj = data.versions || {};
  const versionNames = Object.keys(versionsObj);
  const numberOfVersions = versionNames.length;

  // Intentional signal: skip drive-by packages that only published once.
  if (numberOfVersions <= 1) {
    return null;
  }

  const createdStr = data.time?.created;
  if (!createdStr) {
    return null;
  }

  const createdDate = new Date(createdStr);
  if (Number.isNaN(createdDate.getTime())) {
    return null;
  }

  const ageMs = now - createdDate.getTime();
  if (ageMs < 0 || ageMs > daysBack * MS_PER_DAY) {
    return null;
  }

  const latestVersion =
    data["dist-tags"]?.latest || versionNames[versionNames.length - 1];

  let description =
    data.description ||
    (latestVersion ? versionsObj[latestVersion]?.description : "") ||
    "";
  description = description.replace(/[\r\n\t]+/g, " ").trim();

  const versionData = latestVersion ? versionsObj[latestVersion] : undefined;
  const hasBin = hasBinEntry(versionData?.bin);

  return {
    ecosystem: "npm",
    name: pkgName,
    version: latestVersion,
    description,
    publishedAt: createdDate,
    npmUrl: `${NPM_PACKAGE_URL_BASE}/${encodeURIComponent(pkgName)}`,
    numberOfVersions,
    hasBin,
  };
}

function hasBinEntry(bin: unknown): boolean {
  if (typeof bin === "string") {
    return bin.length > 0;
  }
  if (bin && typeof bin === "object") {
    return Object.keys(bin).length > 0;
  }
  return false;
}

function passesNpmFilters(
  info: PackageInfo,
  terms: string[],
  partialMatch: boolean,
  requireBin: boolean
): boolean {
  if (requireBin && !info.hasBin) {
    return false;
  }

  if (terms.length === 0) {
    return true;
  }

  const nameMatches = matchesSearch(info.name, {
    terms,
    partialMatch,
    caseInsensitive: true,
  });
  const descMatches = matchesSearch(info.description, {
    terms,
    partialMatch,
    caseInsensitive: true,
  });

  return nameMatches || descMatches;
}

async function processPackageNames(
  names: string[],
  options: {
    daysBack: number;
    now: number;
    maxResults: number;
    concurrency: number;
    terms: string[];
    partialMatch: boolean;
    minJsLines: number | undefined;
    requireBin: boolean;
  }
): Promise<PackageInfo[]> {
  const results: PackageInfo[] = [];
  let index = 0;
  const hasJsLinesFilter =
    options.minJsLines !== undefined && options.minJsLines > 0;

  async function worker(): Promise<void> {
    while (index < names.length && results.length < options.maxResults) {
      const name = names[index++];

      try {
        const doc = await fetchPackageDocument(name);
        if (!doc) continue;

        const info = packageInfoFromDocument(
          name,
          doc,
          options.daysBack,
          options.now
        );
        if (!info) continue;

        if (!passesNpmFilters(
          info,
          options.terms,
          options.partialMatch,
          options.requireBin
        )) {
          continue;
        }

        if (hasJsLinesFilter) {
          console.log(`Counting JS lines for ${info.name}@${info.version}...`);
          const jsLines = await countJsLinesInPackage(info.name, info.version);
          info.jsLines = jsLines;

          if (jsLines < options.minJsLines!) {
            console.log(`  Skipped: ${info.name} has only ${jsLines} JS lines`);
            continue;
          }
        } else if (options.minJsLines === 0) {
          console.log(`Counting JS lines for ${info.name}@${info.version}...`);
          info.jsLines = await countJsLinesInPackage(info.name, info.version);
        }

        if (results.length >= options.maxResults) {
          continue;
        }

        results.push(info);
        console.log(
          `Found: ${info.name}@${info.version}${info.jsLines !== undefined ? ` (${info.jsLines} JS lines)` : ""} [${results.length}/${options.maxResults}]`
        );
      } catch (err) {
        console.error(`Error checking ${name}:`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, () => worker())
  );

  return results;
}

/**
 * Fetch recent npm packages and return the results.
 */
export async function getRecentNpmPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const {
    changesLimit = 200,
    maxResults = 30,
    daysBack = 7,
    concurrency = 10,
    searchTerms = "",
    partialMatch = true,
    minJsLines,
    maxPages = 1000,
    requireBin = false,
    npmStartSeq,
    npmHeadSeq,
    now = Date.now(),
  } = options;

  const terms = searchTerms ? parseSearchTerms(searchTerms) : [];

  console.log(
    `Searching for packages whose first version was published within the last ${daysBack} day(s)...`
  );
  console.log(`Will fetch ${changesLimit} change rows per page from npm _changes.`);
  console.log("Using stateless npm sequence probing; start sequence is approximate.");

  if (terms.length > 0) {
    console.log(`Filtering by name or description containing: ${terms.join(" AND ")}`);
  }

  if (minJsLines !== undefined && minJsLines > 0) {
    console.log(`Filtering by minimum ${minJsLines} JavaScript lines`);
  }

  if (requireBin) {
    console.log("Filtering for packages with CLI bin entries only");
  }

  const headSeq = npmHeadSeq ?? await fetchHeadSeq();
  const startSeq = npmStartSeq ??
    await findApproximateStartSeq(headSeq, daysBack, now);

  console.log(`Scanning npm _changes forward from seq ${startSeq} to ${headSeq}.`);

  const { names, rowsSeen, pagesSeen } = await collectChangedPackageNames(
    startSeq,
    headSeq,
    changesLimit,
    maxPages
  );

  const results = await processPackageNames(names, {
    daysBack,
    now,
    maxResults,
    concurrency,
    terms,
    partialMatch,
    minJsLines,
    requireBin,
  });

  if (pagesSeen >= maxPages && startSeq < headSeq) {
    console.log(`\nReached maximum page limit (${maxPages} pages).`);
  }

  console.log(
    `\nSearch complete! Checked ${names.length} unique package(s) from ${rowsSeen} change row(s) across ${pagesSeen} page(s).`
  );
  console.log(`Found ${results.length} package(s) matching your criteria.`);

  return results;
}
