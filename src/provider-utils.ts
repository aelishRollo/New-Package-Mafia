import { matchesSearch, parseSearchTerms } from "./description-filter.js";
import type { GetRecentPackagesOptions, PackageInfo } from "./package-types.js";

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function isWithinDays(date: Date, daysBack: number, now: number): boolean {
  const ageMs = now - date.getTime();
  return ageMs >= 0 && ageMs <= daysBack * MS_PER_DAY;
}

export function normalizeDescription(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
}

export function registryFetch(url: string | URL): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(5_000),
    headers: {
      "User-Agent": "New-Package-Mafia/1.0 (package registry research tool)",
    },
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function passesCommonFilters(
  pkg: PackageInfo,
  options: Pick<GetRecentPackagesOptions, "searchTerms" | "partialMatch" | "requireBin">
): boolean {
  if (options.requireBin && !pkg.hasBin) {
    return false;
  }

  const terms = options.searchTerms ? parseSearchTerms(options.searchTerms) : [];
  if (terms.length === 0) {
    return true;
  }

  const partialMatch = options.partialMatch ?? true;
  return (
    matchesSearch(pkg.name, { terms, partialMatch, caseInsensitive: true }) ||
    matchesSearch(pkg.description, { terms, partialMatch, caseInsensitive: true })
  );
}

export async function runConcurrently<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function runOne(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => runOne())
  );
}
