/**
 * Find "truly new" npm packages:
 *  - whose FIRST version was published within the last N days (default 7)
 *  - may have multiple versions (we track the count)
 *  - optionally filter by description search terms
 *  - optionally filter by minimum JavaScript lines
 *
 * Requires: Node 18+ (for global fetch).
 */

import { matchesSearch, parseSearchTerms } from "./description-filter.js";
import { countJsLinesInPackage } from "./js-lines-counter.js";

const REGISTRY_CHANGES_URL = "https://replicate.npmjs.com/registry/_changes";
const REGISTRY_DOC_URL_BASE = "https://registry.npmjs.org";
const NPM_PACKAGE_URL_BASE = "https://www.npmjs.com/package";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface PackageInfo {
  name: string;
  version: string;
  description: string;
  publishedAt: Date;
  npmUrl: string;
  numberOfVersions: number;
  jsLines?: number;
  hasBin?: boolean;
  aiSummary?: string;
}

export interface GetRecentNpmOptions {
  changesLimit?: number;
  maxResults?: number;
  daysBack?: number;
  concurrency?: number;
  searchTerms?: string;
  partialMatch?: boolean;
  minJsLines?: number;
  maxPages?: number;
  requireBin?: boolean;
}

interface ChangesResponse {
  results: Array<{ id: string }>;
  last_seq: string;
}

/**
 * Fetch a slice of the npm changes feed and return unique package IDs plus last_seq.
 */
async function getRecentPackageNames(
  limit: number,
  since?: string
): Promise<{ names: string[]; lastSeq: string }> {
  const url = new URL(REGISTRY_CHANGES_URL);
  url.searchParams.set("descending", "true");
  url.searchParams.set("limit", String(limit));

  if (since) {
    url.searchParams.set("since", since);
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`_changes request failed: ${res.status} ${res.statusText}`);
  }

  const data: ChangesResponse = await res.json();
  const seen = new Set<string>();
  const names: string[] = [];

  for (const row of data.results ?? []) {
    const id = row.id;
    if (!id) continue;
    if (id.startsWith("_design/")) continue; // skip internal docs

    if (!seen.has(id)) {
      seen.add(id);
      names.push(id);
    }
  }

  return {
    names,
    lastSeq: data.last_seq,
  };
}

/**
 * Return info if package's FIRST version was published within `daysBack` days.
 * The package may have multiple versions - we track the count.
 * Otherwise returns null.
 */
async function getIfFirstVersionRecent(
  pkgName: string,
  daysBack: number,
  now: number
): Promise<PackageInfo | null> {
  const url = `${REGISTRY_DOC_URL_BASE}/${encodeURIComponent(pkgName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${pkgName}: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = await res.json();
  const versionsObj = data.versions || {};
  const versionNames = Object.keys(versionsObj);
  const numberOfVersions = versionNames.length;

  if (numberOfVersions === 0) {
    return null;
  }

  const timeMap = data.time || {};

  // Get the creation time (first version publish time)
  const createdStr = timeMap.created;
  if (!createdStr) {
    return null;
  }

  const createdDate = new Date(createdStr);
  if (Number.isNaN(createdDate.getTime())) {
    return null;
  }

  const ageMs = now - createdDate.getTime();
  const maxAgeMs = daysBack * MS_PER_DAY;

  if (ageMs < 0 || ageMs > maxAgeMs) {
    // From the future (clock skew) or older than our window
    return null;
  }

  // Get the latest version for display
  const latestVersion =
    data["dist-tags"]?.latest || versionNames[versionNames.length - 1];

  // Prefer top-level description, then version-specific description.
  let description =
    data.description ||
    (versionsObj[latestVersion] && versionsObj[latestVersion].description) ||
    "";

  // Normalize newlines/tabs so they don't blow up readability
  description = description.replace(/[\r\n\t]+/g, " ").trim();

  const npmUrl = `${NPM_PACKAGE_URL_BASE}/${encodeURIComponent(pkgName)}`;

  // Check if package has a bin entry (CLI command)
  const versionData = versionsObj[latestVersion];
  const hasBin = !!(versionData?.bin && Object.keys(versionData.bin).length > 0);

  return {
    name: pkgName,
    version: latestVersion,
    description,
    publishedAt: createdDate,
    npmUrl,
    numberOfVersions,
    hasBin,
  };
}

/**
 * Fetch recent npm packages and return the results.
 * Automatically pages through the changes feed until enough results are found.
 */
export async function getRecentNpmPackages(
  options: GetRecentNpmOptions = {}
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
  } = options;

  const now = Date.now();

  // Parse search terms if provided
  const terms = searchTerms ? parseSearchTerms(searchTerms) : [];
  const hasSearchFilter = terms.length > 0;
  const hasJsLinesFilter = minJsLines !== undefined && minJsLines > 0;

  console.log(
    `Searching for packages whose first version was published within the last ${daysBack} day(s)...`
  );
  console.log(`Will fetch ${changesLimit} packages per page from changes feed.`);

  if (hasSearchFilter) {
    console.log(`Filtering by name or description containing: ${terms.join(" AND ")}`);
  }

  if (hasJsLinesFilter) {
    console.log(`Filtering by minimum ${minJsLines} JavaScript lines`);
  }

  if (requireBin) {
    console.log("Filtering for packages with CLI bin entries only");
  }

  const results: PackageInfo[] = [];
  let lastSeq: string | undefined;
  let pageNumber = 0;
  let totalPackagesChecked = 0;
  let oldestUpdateDate: Date | null = null;
  let newestUpdateDate: Date | null = null;

  // Keep fetching pages until we have enough results or run out of packages
  while (results.length < maxResults && pageNumber < maxPages) {
    pageNumber++;
    console.log(`\nFetching page ${pageNumber} (up to ${changesLimit} packages)...`);

    const { names, lastSeq: newLastSeq } = await getRecentPackageNames(
      changesLimit,
      lastSeq
    );

    if (names.length === 0) {
      console.log("No more packages available in changes feed.");
      break;
    }

    console.log(`Got ${names.length} unique package IDs from page ${pageNumber}.`);
    totalPackagesChecked += names.length;

    // Track dates in this page
    let pageOldestDate: Date | null = null;
    let pageNewestDate: Date | null = null;

    // Process this page's packages concurrently
    let index = 0;

    async function worker() {
      while (index < names.length && results.length < maxResults) {
        const currentIndex = index++;
        const name = names[currentIndex];

        try {
          const info = await getIfFirstVersionRecent(name, daysBack, now);
          if (!info) {
            continue;
          }

          // Track date range for this page
          if (!pageNewestDate || info.publishedAt > pageNewestDate) {
            pageNewestDate = info.publishedAt;
          }
          if (!pageOldestDate || info.publishedAt < pageOldestDate) {
            pageOldestDate = info.publishedAt;
          }

          // Apply bin filter
          if (requireBin && !info.hasBin) {
            continue;
          }

          // Apply search filter (check both name and description)
          if (hasSearchFilter) {
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

            // Match if found in either name OR description
            if (!nameMatches && !descMatches) {
              continue;
            }
          }

          // Apply JS lines filter (lazy evaluation - only count if needed)
          if (hasJsLinesFilter) {
            console.log(`Counting JS lines for ${info.name}@${info.version}...`);
            const jsLines = await countJsLinesInPackage(info.name, info.version);
            info.jsLines = jsLines;

            if (jsLines < minJsLines) {
              console.log(`  Skipped: ${info.name} has only ${jsLines} JS lines`);
              continue;
            }
          } else if (minJsLines === 0) {
            // If user explicitly set minJsLines to 0, still count but don't filter
            console.log(`Counting JS lines for ${info.name}@${info.version}...`);
            info.jsLines = await countJsLinesInPackage(info.name, info.version);
          }

          results.push(info);
          console.log(
            `Found: ${info.name}@${info.version}${info.jsLines !== undefined ? ` (${info.jsLines} JS lines)` : ""} [${results.length}/${maxResults}]`
          );
        } catch (err) {
          console.error(`Error checking ${name}:`, err);
        }
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    // Update overall date range
    if (pageNewestDate) {
      if (!newestUpdateDate || pageNewestDate > newestUpdateDate) {
        newestUpdateDate = pageNewestDate;
      }
    }
    if (pageOldestDate) {
      if (!oldestUpdateDate || pageOldestDate < oldestUpdateDate) {
        oldestUpdateDate = pageOldestDate;
      }
    }

    // Log page completion with date range
    console.log(
      `Page ${pageNumber} complete. Found ${results.length}/${maxResults} matching packages so far.`
    );

    if (pageOldestDate && pageNewestDate) {
      const oldest: Date = pageOldestDate;
      const newest: Date = pageNewestDate;
      const oldestStr = oldest.toISOString().split("T")[0];
      const newestStr = newest.toISOString().split("T")[0];
      console.log(`  Date range of packages in this page: ${oldestStr} to ${newestStr}`);
    }

    // If we have enough results, stop
    if (results.length >= maxResults) {
      console.log("Found enough matching packages!");
      break;
    }

    // Check if we got no results at all (truly empty response)
    if (names.length === 0) {
      console.log("No more packages in feed.");
      break;
    }

    // Update lastSeq for next iteration
    lastSeq = newLastSeq;
  }

  if (pageNumber >= maxPages) {
    console.log(`\nReached maximum page limit (${maxPages} pages).`);
  }

  console.log(
    `\nSearch complete! Checked ${totalPackagesChecked} packages across ${pageNumber} page(s).`
  );

  if (oldestUpdateDate && newestUpdateDate) {
    const oldest: Date = oldestUpdateDate;
    const newest: Date = newestUpdateDate;
    const oldestStr = oldest.toISOString().split("T")[0];
    const newestStr = newest.toISOString().split("T")[0];
    console.log(`Overall date range examined: ${oldestStr} to ${newestStr}`);
  }

  console.log(`Found ${results.length} package(s) matching your criteria.`);

  return results;
}
