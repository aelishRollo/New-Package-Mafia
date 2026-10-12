export type PackageProvider = "npm" | "rust" | "ruby" | "go" | "java";

export interface PackageInfo {
  ecosystem: PackageProvider;
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

export interface GetRecentPackagesOptions {
  provider?: PackageProvider;
  changesLimit?: number;
  maxResults?: number;
  daysBack?: number;
  concurrency?: number;
  searchTerms?: string;
  partialMatch?: boolean;
  minJsLines?: number;
  maxPages?: number;
  requireBin?: boolean;
  /** Test/debug hook: use this sequence as the npm forward scan start. */
  npmStartSeq?: number;
  /** Test/debug hook: freeze the npm scan end sequence without fetching head. */
  npmHeadSeq?: number;
  /** Test/debug hook: freeze "now" for date-window checks. */
  now?: number;
}

export const PACKAGE_PROVIDERS: PackageProvider[] = [
  "npm",
  "rust",
  "ruby",
  "go",
  "java",
];

export function isPackageProvider(value: string): value is PackageProvider {
  return (PACKAGE_PROVIDERS as string[]).includes(value);
}
