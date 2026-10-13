import type { GetRecentPackagesOptions, PackageInfo } from "./package-types.js";
import { gunzipSync } from "zlib";
import {
  isWithinDays,
  errorMessage,
  normalizeDescription,
  passesCommonFilters,
  registryFetch,
  runConcurrently,
} from "./provider-utils.js";

const CRATES_URL = "https://crates.io/api/v1/crates";
const CRATES_MAX_PER_PAGE = 100;
const CRATES_PAGE_DELAY_MS = 1_000;
const CRATES_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024;
const CRATES_CARGO_TOML_MAX_BYTES = 512 * 1024;
const RUBYGEMS_LATEST_URL = "https://rubygems.org/api/v1/activity/latest.json";
const RUBYGEMS_UPDATED_URL = "https://rubygems.org/api/v1/activity/just_updated.json";
const RUBYGEMS_VERSIONS_BASE = "https://rubygems.org/api/v1/versions";
const GO_INDEX_URL = "https://index.golang.org/index";
const GO_PROXY_BASE = "https://proxy.golang.org";
const MAVEN_SEARCH_URL = "https://search.maven.org/solrsearch/select";

interface CrateSummary {
  name: string;
  newest_version?: string;
  max_version?: string;
  default_version?: string;
  num_versions: number;
  created_at: string;
  description?: string;
}

interface RustCrateInspection {
  binSignals: string[];
  hasBin: boolean;
}

interface RubyGemActivity {
  name: string;
  version: string;
  version_created_at: string;
  info?: string;
  project_uri?: string;
}

interface RubyGemVersion {
  number: string;
  created_at: string;
  info?: string;
  summary?: string;
  project_uri?: string;
}

interface GoIndexRow {
  Path: string;
  Version: string;
  Timestamp: string;
}

interface GoVersionInfo {
  Version: string;
  Time: string;
}

interface MavenDoc {
  g: string;
  a: string;
  v: string;
  timestamp: number;
}

interface MavenResponse {
  response?: {
    numFound?: number;
    docs?: MavenDoc[];
  };
}

export async function getRecentRustPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const {
    changesLimit = 100,
    maxResults = 30,
    daysBack = 7,
    maxPages = 10,
  } = options;
  const now = options.now ?? Date.now();
  const perPage = Math.min(Math.max(1, changesLimit), CRATES_MAX_PER_PAGE);
  const results: PackageInfo[] = [];

  console.log(`Searching crates.io for new crates from the last ${daysBack} day(s)...`);

  for (let page = 1; page <= maxPages && results.length < maxResults; page++) {
    const url = new URL(CRATES_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("sort", "new");

    const res = await registryFetch(url);
    if (!res.ok) {
      throw new Error(`crates.io request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { crates?: CrateSummary[] };
    const crates = data.crates ?? [];
    if (crates.length === 0) break;

    for (const crate of crates) {
      if (results.length >= maxResults) break;
      const created = new Date(crate.created_at);
      if (Number.isNaN(created.getTime())) continue;
      if (!isWithinDays(created, daysBack, now)) return results;
      if (crate.num_versions <= 1) continue;

      const version = crate.newest_version || crate.max_version || crate.default_version || "";
      const pkg: PackageInfo = {
        ecosystem: "rust",
        name: crate.name,
        version,
        description: normalizeDescription(crate.description),
        publishedAt: created,
        npmUrl: `https://crates.io/crates/${encodeURIComponent(crate.name)}`,
        numberOfVersions: crate.num_versions,
        hasBin: false,
        binSignals: [],
      };

      if (passesCommonFilters(pkg, options)) {
        const inspection = await inspectRustCrate(crate.name, version);
        pkg.hasBin = inspection.hasBin;
        pkg.binSignals = inspection.binSignals;
        results.push(pkg);
        console.log(`Found rust: ${pkg.name}@${pkg.version} [${results.length}/${maxResults}]`);
      }
    }

    if (crates.length < perPage || results.length >= maxResults) break;
    if (page < maxPages) {
      // ken: one-request-per-second crates.io paging; revisit only if API policy changes or scans move off the public API.
      await sleep(CRATES_PAGE_DELAY_MS);
    }
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function inspectRustCrate(name: string, version: string): Promise<RustCrateInspection> {
  if (!version) {
    return { binSignals: [], hasBin: false };
  }

  try {
    const url = `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`;
    const res = await registryFetch(url);
    if (!res.ok) {
      return { binSignals: [], hasBin: false };
    }

    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > CRATES_DOWNLOAD_MAX_BYTES) {
      return { binSignals: [], hasBin: false };
    }

    const bytes = await readResponseBodyWithLimit(res, CRATES_DOWNLOAD_MAX_BYTES);
    if (!bytes) {
      return { binSignals: [], hasBin: false };
    }

    const cargoToml = readCargoTomlFromCrate(bytes);
    if (!cargoToml) {
      return { binSignals: [], hasBin: false };
    }

    return inspectCargoToml(cargoToml);
  } catch {
    return { binSignals: [], hasBin: false };
  }
}

async function readResponseBodyWithLimit(res: Response, maxBytes: number): Promise<Buffer | null> {
  if (!res.body) {
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function readCargoTomlFromCrate(crateBytes: Buffer): string | null {
  const tarBytes = gunzipSync(crateBytes);
  let offset = 0;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const path = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullPath = prefix ? `${prefix}/${path}` : path;
    const size = parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (fullPath.endsWith("/Cargo.toml") && !fullPath.endsWith("/Cargo.toml.orig")) {
      if (size > CRATES_CARGO_TOML_MAX_BYTES) return null;
      return tarBytes.subarray(dataStart, dataEnd).toString("utf8");
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return null;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString("utf8");
}

function inspectCargoToml(cargoToml: string): RustCrateInspection {
  const binSignals: string[] = [];
  if (/^\s*\[\[bin\]\]/m.test(cargoToml)) {
    binSignals.push("cli");
  }
  if (hasCargoDependency(cargoToml, "gpui")) {
    binSignals.push("gpui");
  }
  if (
    hasCargoDependency(cargoToml, "tauri") ||
    hasCargoDependency(cargoToml, "tauri-build") ||
    hasCargoDependencyPrefix(cargoToml, "tauri-plugin-")
  ) {
    binSignals.push("tauri");
  }

  return { binSignals, hasBin: binSignals.includes("cli") };
}

function hasCargoDependency(cargoToml: string, name: string): boolean {
  return hasCargoDependencyMatching(cargoToml, (dependency) => dependency === name);
}

function hasCargoDependencyPrefix(cargoToml: string, prefix: string): boolean {
  return hasCargoDependencyMatching(cargoToml, (dependency) => dependency.startsWith(prefix));
}

function hasCargoDependencyMatching(
  cargoToml: string,
  matches: (dependency: string) => boolean
): boolean {
  let section = "";

  for (const rawLine of cargoToml.split("\n")) {
    const line = rawLine.split("#")[0].trim();
    if (!line) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      const tableMatch = section.match(/^(?:dependencies|build-dependencies)\.([\w-]+)$/);
      if (tableMatch && matches(tableMatch[1])) return true;
      continue;
    }

    if (section !== "dependencies" && section !== "build-dependencies") {
      continue;
    }

    const keyMatch = line.match(/^([\w-]+)\s*=/);
    if (keyMatch && matches(keyMatch[1])) return true;
  }

  return false;
}

export async function getRecentRubyPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const {
    maxResults = 30,
    daysBack = 7,
    concurrency = 8,
  } = options;
  const now = Date.now();
  const names = new Set<string>();
  const results: PackageInfo[] = [];

  console.log(`Searching RubyGems for new gems from the last ${daysBack} day(s)...`);

  for (const feedUrl of [RUBYGEMS_LATEST_URL, RUBYGEMS_UPDATED_URL]) {
    const res = await registryFetch(feedUrl);
    if (!res.ok) {
      throw new Error(`RubyGems activity request failed: ${res.status} ${res.statusText}`);
    }
    const gems = (await res.json()) as RubyGemActivity[];
    for (const gem of gems) {
      if (gem.name) names.add(gem.name);
    }
  }

  await runConcurrently([...names], concurrency, async (name) => {
    if (results.length >= maxResults) return;
    try {
      const pkg = await getRubyPackageIfNew(name, daysBack, now);
      if (pkg && passesCommonFilters(pkg, options) && results.length < maxResults) {
        results.push(pkg);
        console.log(`Found ruby: ${pkg.name}@${pkg.version} [${results.length}/${maxResults}]`);
      }
    } catch (err) {
      console.error(`Error checking RubyGem ${name}: ${errorMessage(err)}`);
    }
  });

  return results.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

async function getRubyPackageIfNew(
  name: string,
  daysBack: number,
  now: number
): Promise<PackageInfo | null> {
  const res = await registryFetch(`${RUBYGEMS_VERSIONS_BASE}/${encodeURIComponent(name)}.json`);
  if (!res.ok) return null;

  const versions = (await res.json()) as RubyGemVersion[];
  if (versions.length <= 1) return null;

  const dated = versions
    .map((version) => ({ version, date: new Date(version.created_at) }))
    .filter(({ date }) => !Number.isNaN(date.getTime()));
  if (dated.length <= 1) return null;

  let earliest = dated[0];
  let latest = dated[0];
  for (const item of dated) {
    if (item.date < earliest.date) earliest = item;
    if (item.date > latest.date) latest = item;
  }

  if (!isWithinDays(earliest.date, daysBack, now)) return null;

  return {
    ecosystem: "ruby",
    name,
    version: latest.version.number,
    description: normalizeDescription(latest.version.info || latest.version.summary),
    publishedAt: earliest.date,
    npmUrl: latest.version.project_uri || `https://rubygems.org/gems/${encodeURIComponent(name)}`,
    numberOfVersions: versions.length,
    hasBin: false,
  };
}

export async function getRecentGoPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const {
    changesLimit = 2000,
    maxResults = 30,
    daysBack = 7,
    concurrency = 6,
    maxPages = 1,
  } = options;
  const now = Date.now();
  const since = new Date(now - daysBack * 24 * 60 * 60 * 1000);
  const candidates = new Map<string, GoIndexRow[]>();
  const results: PackageInfo[] = [];

  console.log(`Searching Go module index for new modules from the last ${daysBack} day(s)...`);

  let nextSince = since.toISOString();
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(GO_INDEX_URL);
    url.searchParams.set("since", nextSince);
    url.searchParams.set("limit", String(changesLimit));

    const res = await registryFetch(url);
    if (!res.ok) {
      throw new Error(`Go index request failed: ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    const rows = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GoIndexRow);
    if (rows.length === 0) break;

    for (const row of rows) {
      const pathRows = candidates.get(row.Path) ?? [];
      pathRows.push(row);
      candidates.set(row.Path, pathRows);
    }

    const last = rows[rows.length - 1];
    if (rows.length < changesLimit || !last?.Timestamp) break;
    nextSince = last.Timestamp;
  }

  const pathsWithMultipleRecentVersions = [...candidates.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([path]) => path);

  await runConcurrently(pathsWithMultipleRecentVersions, concurrency, async (path) => {
    if (results.length >= maxResults) return;
    try {
      const pkg = await getGoPackageIfNew(path, daysBack, now);
      if (pkg && passesCommonFilters(pkg, options) && results.length < maxResults) {
        results.push(pkg);
        console.log(`Found go: ${pkg.name}@${pkg.version} [${results.length}/${maxResults}]`);
      }
    } catch (err) {
      console.error(`Error checking Go module ${path}: ${errorMessage(err)}`);
    }
  });

  return results.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

async function getGoPackageIfNew(
  path: string,
  daysBack: number,
  now: number
): Promise<PackageInfo | null> {
  const escapedPath = escapeGoModulePath(path);
  const listRes = await registryFetch(`${GO_PROXY_BASE}/${escapedPath}/@v/list`);
  if (!listRes.ok) return null;

  const versions = (await listRes.text()).split("\n").filter(Boolean);
  if (versions.length <= 1) return null;
  // ken: brute-force version info fetch; skip pathological old modules until Go provider needs >50-version newborns.
  if (versions.length > 50) return null;

  const infos: GoVersionInfo[] = [];
  await runConcurrently(versions, 6, async (version) => {
    const res = await registryFetch(`${GO_PROXY_BASE}/${escapedPath}/@v/${encodeURIComponent(version)}.info`);
    if (!res.ok) return;
    infos.push((await res.json()) as GoVersionInfo);
  });
  if (infos.length <= 1) return null;

  let earliest = infos[0];
  let latest = infos[0];
  for (const info of infos) {
    if (new Date(info.Time) < new Date(earliest.Time)) earliest = info;
    if (new Date(info.Time) > new Date(latest.Time)) latest = info;
  }

  const earliestDate = new Date(earliest.Time);
  if (!isWithinDays(earliestDate, daysBack, now)) return null;

  return {
    ecosystem: "go",
    name: path,
    version: latest.Version,
    description: "",
    publishedAt: earliestDate,
    npmUrl: `https://pkg.go.dev/${path}`,
    numberOfVersions: versions.length,
    hasBin: false,
  };
}

function escapeGoModulePath(path: string): string {
  return path
    .split("")
    .map((char) => {
      if (char >= "A" && char <= "Z") {
        return `!${char.toLowerCase()}`;
      }
      return encodeURIComponent(char);
    })
    .join("");
}

export async function getRecentJavaPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const {
    changesLimit = 200,
    maxResults = 30,
    daysBack = 7,
    concurrency = 8,
    maxPages = 3,
  } = options;
  const now = Date.now();
  const coordinates = new Map<string, MavenDoc>();
  const results: PackageInfo[] = [];

  console.log(`Searching Maven Central for new artifacts from the last ${daysBack} day(s)...`);

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(MAVEN_SEARCH_URL);
    url.searchParams.set("q", "*:*");
    url.searchParams.set("core", "gav");
    url.searchParams.set("rows", String(changesLimit));
    url.searchParams.set("start", String(page * changesLimit));
    url.searchParams.set("wt", "json");
    url.searchParams.set("sort", "timestamp desc");

    const res = await registryFetch(url);
    if (!res.ok) {
      throw new Error(`Maven Central request failed: ${res.status} ${res.statusText}`);
    }

    const docs = ((await res.json()) as MavenResponse).response?.docs ?? [];
    if (docs.length === 0) break;

    for (const doc of docs) {
      coordinates.set(`${doc.g}:${doc.a}`, doc);
    }
  }

  await runConcurrently([...coordinates.values()], concurrency, async (doc) => {
    if (results.length >= maxResults) return;
    try {
      const pkg = await getMavenPackageIfNew(doc, daysBack, now);
      if (pkg && passesCommonFilters(pkg, options) && results.length < maxResults) {
        results.push(pkg);
        console.log(`Found java: ${pkg.name}@${pkg.version} [${results.length}/${maxResults}]`);
      }
    } catch (err) {
      console.error(`Error checking Maven artifact ${doc.g}:${doc.a}: ${errorMessage(err)}`);
    }
  });

  return results.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

async function getMavenPackageIfNew(
  doc: MavenDoc,
  daysBack: number,
  now: number
): Promise<PackageInfo | null> {
  const baseQuery = `g:"${doc.g}" AND a:"${doc.a}"`;
  const earliestUrl = new URL(MAVEN_SEARCH_URL);
  earliestUrl.searchParams.set("q", baseQuery);
  earliestUrl.searchParams.set("core", "gav");
  earliestUrl.searchParams.set("rows", "1");
  earliestUrl.searchParams.set("wt", "json");
  earliestUrl.searchParams.set("sort", "timestamp asc");

  const earliestRes = await registryFetch(earliestUrl);
  if (!earliestRes.ok) return null;

  const earliestData = (await earliestRes.json()) as MavenResponse;
  const count = earliestData.response?.numFound ?? 0;
  if (count <= 1) return null;

  const earliestDoc = earliestData.response?.docs?.[0];
  if (!earliestDoc) return null;

  const earliestDate = new Date(earliestDoc.timestamp);
  if (!isWithinDays(earliestDate, daysBack, now)) return null;

  const name = `${doc.g}:${doc.a}`;
  return {
    ecosystem: "java",
    name,
    version: doc.v,
    description: "",
    publishedAt: earliestDate,
    npmUrl: `https://central.sonatype.com/artifact/${doc.g}/${doc.a}`,
    numberOfVersions: count,
    hasBin: false,
  };
}
