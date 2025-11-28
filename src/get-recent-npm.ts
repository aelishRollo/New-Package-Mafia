// npm-single-version.ts
// Fetch recent-ish packages from the npm search API
// and export data to CSV including version count and first publish date.

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const REGISTRY_URL = 'https://registry.npmjs.org';

// How many results to fetch from search
const PAGE_SIZE = 50;
// Change this to adjust which packages you see,
// e.g. 'keywords:javascript', 'react', 'author:username', etc.
const SEARCH_TEXT = 'keywords:javascript';

const OUTPUT_DIR = 'out';

function getOutputFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return join(OUTPUT_DIR, `${timestamp}-npm-packages.csv`);
}

interface SearchOptions {
  size?: number;
  from?: number;
  text?: string;
}

interface NpmSearchPackage {
  name: string;
  version: string;
  description?: string;
}

interface NpmSearchObject {
  package: NpmSearchPackage;
}

interface NpmSearchResponse {
  objects: NpmSearchObject[];
  total: number;
}

interface NpmPackageResponse {
  versions?: Record<string, unknown>;
  time?: Record<string, string>;
}

interface PackageResult {
  name: string;
  versionCount: number;
  firstPublishDate: string;
  npmUrl: string;
}

async function getPackagesFromSearch({
  size = PAGE_SIZE,
  from = 0,
  text = SEARCH_TEXT,
}: SearchOptions = {}): Promise<string[]> {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('text', text);
  url.searchParams.set('size', String(size));
  url.searchParams.set('from', String(from));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search failed: ${res.status} ${res.statusText}`);
  }

  const data: NpmSearchResponse = await res.json();
  return data.objects.map((obj) => obj.package.name);
}

async function getPackageDetails(pkgName: string): Promise<PackageResult> {
  const url = `${REGISTRY_URL}/${encodeURIComponent(pkgName)}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${pkgName}: ${res.status} ${res.statusText}`);
    return {
      name: pkgName,
      versionCount: 0,
      firstPublishDate: 'unknown',
      npmUrl: `https://www.npmjs.com/package/${pkgName}`,
    };
  }

  const data: NpmPackageResponse = await res.json();
  const versions = data.versions ?? {};
  const time = data.time ?? {};

  const versionCount = Object.keys(versions).length;

  // Get the first publish date (the 'created' field in time object)
  const firstPublishDate = time.created ?? 'unknown';

  return {
    name: pkgName,
    versionCount,
    firstPublishDate,
    npmUrl: `https://www.npmjs.com/package/${pkgName}`,
  };
}

function escapeCSVField(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

function writeCSV(results: PackageResult[], filename: string): void {
  const headers = ['name', 'version_count', 'first_publish_date', 'npm_url'];
  const rows = results.map((r) => [
    escapeCSVField(r.name),
    String(r.versionCount),
    escapeCSVField(r.firstPublishDate),
    escapeCSVField(r.npmUrl),
  ]);

  const csv = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  writeFileSync(filename, csv, 'utf-8');
}

async function main(): Promise<void> {
  console.log(`Fetching packages from npm search for text="${SEARCH_TEXT}"...`);
  const packageNames = await getPackagesFromSearch();

  console.log(`Got ${packageNames.length} packages. Fetching details...`);

  // Fetch all package details in parallel
  const results: PackageResult[] = await Promise.all(
    packageNames.map((name) => getPackageDetails(name))
  );

  // Ensure output directory exists
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Write to CSV
  const outputFile = getOutputFilename();
  writeCSV(results, outputFile);
  console.log(`Wrote ${results.length} packages to ${outputFile}`);

  // Also print summary to console
  console.log('\nPackages:');
  results.forEach((r) =>
    console.log(`- ${r.name}: ${r.versionCount} versions, first published ${r.firstPublishDate}`)
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
