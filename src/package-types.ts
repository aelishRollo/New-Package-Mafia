export type PackageEcosystem = "npm" | "rust" | "ruby" | "go" | "java";
export type PackageProvider = PackageEcosystem | "all";

export interface PackageInfo {
  ecosystem: PackageEcosystem;
  name: string;
  version: string;
  description: string;
  publishedAt: Date;
  npmUrl: string;
  numberOfVersions: number;
  jsLines?: number;
  hasBin?: boolean;
  binSignals?: string[];
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
  "all",
  "npm",
  "rust",
  "ruby",
  "go",
  "java",
];

export function isPackageProvider(value: string): value is PackageProvider {
  return (PACKAGE_PROVIDERS as string[]).includes(value);
}
