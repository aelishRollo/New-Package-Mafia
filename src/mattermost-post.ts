import type { PackageInfo } from "./package-types.js";

interface MattermostPayload {
  text?: string;
  username?: string;
  icon_url?: string;
  channel?: string;
}

const ECOSYSTEM_ORDER: Record<PackageInfo["ecosystem"], number> = {
  npm: 0,
  rust: 1,
  ruby: 2,
  go: 3,
  java: 4,
};

function sortPackagesForReport(packages: PackageInfo[]): PackageInfo[] {
  return [...packages].sort((a, b) =>
    ECOSYSTEM_ORDER[a.ecosystem] - ECOSYSTEM_ORDER[b.ecosystem] ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

function formatBinSignals(pkg: PackageInfo): string {
  return (pkg.binSignals ?? (pkg.hasBin ? ["cli"] : [])).join(",");
}

/**
 * Convert package info to a markdown table
 */
export function toMarkdownTable(packages: PackageInfo[]): string {
  if (packages.length === 0) {
    return "No new packages found.";
  }

  const hasJsLines = packages.some((pkg) => pkg.jsLines !== undefined);

  const header = hasJsLines
    ? "| Ecosystem | Name | Description | Published | Versions | Bin | JS Lines |"
    : "| Ecosystem | Name | Description | Published | Versions | Bin |";

  const separator = hasJsLines
    ? "|:----------|:-----|:------------|:----------|:---------|:---:|:---------|"
    : "|:----------|:-----|:------------|:----------|:---------|:---:|";

  const rows = sortPackagesForReport(packages).map((pkg) => {
    const ecosystem = pkg.ecosystem;
    const name = `[${pkg.name}](${pkg.npmUrl})`;
    const desc = (pkg.description || "-").substring(0, 80);
    const published = pkg.publishedAt.toISOString().split("T")[0];
    const versions = pkg.numberOfVersions.toString();
    const bin = formatBinSignals(pkg);

    if (hasJsLines) {
      const jsLines = pkg.jsLines?.toLocaleString() || "0";
      return `| ${ecosystem} | ${name} | ${desc} | ${published} | ${versions} | ${bin} | ${jsLines} |`;
    }

    return `| ${ecosystem} | ${name} | ${desc} | ${published} | ${versions} | ${bin} |`;
  });

  return [header, separator, ...rows].join("\n");
}

/**
 * Post a message to a Mattermost webhook
 */
async function postToMattermost(
  webhookUrl: string,
  payload: MattermostPayload
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Mattermost webhook failed: ${res.status} ${res.statusText} - ${text}`
    );
  }
}

/**
 * Post package info to Mattermost as a markdown table
 */
export async function postPackagesToMattermost(
  packages: PackageInfo[],
  webhookUrl: string
): Promise<void> {
  const sortedPackages = sortPackagesForReport(packages);
  const date = new Date().toISOString().split("T")[0];
  const title = `## New Packages (${date})`;
  const table = toMarkdownTable(sortedPackages);

  // Add AI summaries section if any packages have summaries
  const packagesWithSummaries = sortedPackages.filter(pkg => pkg.aiSummary);
  let summariesSection = "";

  if (packagesWithSummaries.length > 0) {
    summariesSection = "\n\n### AI Summaries\n\n";
    summariesSection += packagesWithSummaries
      .map(pkg => `**${pkg.name}**: ${pkg.aiSummary}`)
      .join("\n");
  }

  const text = `${title}\n\n${table}${summariesSection}`;

  // Mattermost supports up to 16383 characters per post
  if (text.length <= 16000) {
    await postToMattermost(webhookUrl, {
      text,
      username: "Package Tracker",
    });
    console.log("Successfully posted to Mattermost.");
  } else {
    // Split into multiple posts if needed
    await postToMattermost(webhookUrl, {
      text: title,
      username: "Package Tracker",
    });

    const lines = table.split("\n");
    const header = lines[0] + "\n" + lines[1] + "\n";
    let chunk = header;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if ((chunk + line + "\n").length > 15000) {
        await postToMattermost(webhookUrl, {
          text: chunk,
          username: "Package Tracker",
        });
        chunk = header + line + "\n";
      } else {
        chunk += line + "\n";
      }
    }

    if (chunk.length > header.length) {
      await postToMattermost(webhookUrl, {
        text: chunk,
        username: "Package Tracker",
      });
    }

    console.log("Successfully posted to Mattermost (multiple messages).");
  }
}
