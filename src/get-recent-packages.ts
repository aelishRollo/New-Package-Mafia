import { getRecentNpmPackages } from "./get-recent-npm.js";
import {
  getRecentGoPackages,
  getRecentJavaPackages,
  getRecentRubyPackages,
  getRecentRustPackages,
} from "./get-recent-registries.js";
import type { GetRecentPackagesOptions, PackageInfo, PackageEcosystem, PackageProvider } from "./package-types.js";

const REPORT_READY_PROVIDERS: PackageEcosystem[] = ["npm", "rust"];

export async function getRecentPackages(
  options: GetRecentPackagesOptions = {}
): Promise<PackageInfo[]> {
  const provider = options.provider ?? "npm";

  if (provider === "all") {
    return getRecentReportPackages(options);
  }

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

async function getRecentReportPackages(
  options: GetRecentPackagesOptions
): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];

  for (const provider of REPORT_READY_PROVIDERS) {
    const providerOptions: GetRecentPackagesOptions = {
      ...options,
      provider,
    };

    if (provider !== "npm") {
      providerOptions.minJsLines = undefined;
      providerOptions.requireBin = false;
    }

    packages.push(...await getRecentPackages(providerOptions));
  }

  return packages;
}

function assertNever(provider: never): never {
  throw new Error(`Unsupported package provider: ${provider}`);
}

export type { GetRecentPackagesOptions, PackageInfo, PackageProvider };
