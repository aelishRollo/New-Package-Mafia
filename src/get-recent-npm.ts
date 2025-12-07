/**
 * Find "truly new" npm packages:
 *  - whose FIRST version was published within the last N days (default 7)
 *  - may have multiple versions (we track the count)
 *
 * Requires: Node 18+ (for global fetch).
 */

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
}

export interface GetRecentNpmOptions {
  changesLimit?: number;
  maxResults?: number;
  daysBack?: number;
  concurrency?: number;
}

/**
 * Fetch a slice of the npm changes feed and return unique package IDs.
 */
async function getRecentPackageNames(limit: number): Promise<string[]> {
  const url = new URL(REGISTRY_CHANGES_URL);
  url.searchParams.set("descending", "true");
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`_changes request failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
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

  return names;
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

  return {
    name: pkgName,
    version: latestVersion,
    description,
    publishedAt: createdDate,
    npmUrl,
    numberOfVersions,
  };
}

/**
 * Fetch recent npm packages and return the results.
 */
export async function getRecentNpmPackages(
  options: GetRecentNpmOptions = {}
): Promise<PackageInfo[]> {
  const {
    changesLimit = 200,
    maxResults = 30,
    daysBack = 7,
    concurrency = 10,
  } = options;

  const now = Date.now();

  console.log(
    `Inspecting latest ${changesLimit} changes for packages whose first version was ` +
      `published within the last ${daysBack} day(s)...`
  );

  const names = await getRecentPackageNames(changesLimit);
  console.log(`Got ${names.length} unique package IDs from changes feed.`);

  const results: PackageInfo[] = [];
  let index = 0;

  async function worker() {
    while (index < names.length && results.length < maxResults) {
      const currentIndex = index++;
      const name = names[currentIndex];

      try {
        const info = await getIfFirstVersionRecent(name, daysBack, now);
        if (info) {
          results.push(info);
          console.log(`Found: ${info.name}@${info.version}`);
        }
      } catch (err) {
        console.error(`Error checking ${name}:`, err);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(`Found ${results.length} new package(s).`);

  return results;
}
