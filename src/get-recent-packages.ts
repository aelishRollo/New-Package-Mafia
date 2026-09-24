import { getRecentNpmPackages } from "./get-recent-npm.js";
import {
  getRecentGoPackages,
  getRecentJavaPackages,
  getRecentRubyPackages,
  getRecentRustPackages,
} from "./get-recent-registries.js";
import type { GetRecentPackagesOptions, PackageInfo, PackageProvider } from "./package-types.js";

export async function getRecentPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const provider = options.provider ?? "npm";

  switch (provider) {
    case "npm":
      return getRecentNpmPackages(options);
    case "rust":
      return getRecentRustPackages(options);
    case "ruby":
      return getRecentRubyPackages(options);
    case "go":
      return getRecentGoPackages(options);
    case "java":
      return getRecentJavaPackages(options);
    default:
      return assertNever(provider);
  }
}

function assertNever(provider: never): never {
  throw new Error(`Unsupported package provider: ${provider}`);
}

export type { GetRecentPackagesOptions, PackageInfo, PackageProvider };

