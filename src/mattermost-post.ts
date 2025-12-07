import type { PackageInfo } from "./get-recent-npm.js";

interface MattermostPayload {
  text?: string;
  username?: string;
  icon_url?: string;
  channel?: string;
}

/**
 * Convert package info to a markdown table
 */
export function toMarkdownTable(packages: PackageInfo[]): string {
  if (packages.length === 0) {
    return "No new packages found.";
  }

  const header = "| Name | Description | Published | Versions |";
  const separator = "|:-----|:------------|:----------|:---------|";

  const rows = packages.map((pkg) => {
    const name = `[${pkg.name}](${pkg.npmUrl})`;
    const desc = (pkg.description || "-").substring(0, 80);
    const published = pkg.publishedAt.toISOString().split("T")[0];
    const versions = pkg.numberOfVersions.toString();
    return `| ${name} | ${desc} | ${published} | ${versions} |`;
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
  const date = new Date().toISOString().split("T")[0];
  const title = `## New NPM Packages (${date})`;
  const table = toMarkdownTable(packages);
  const text = `${title}\n\n${table}`;

  // Mattermost supports up to 16383 characters per post
  if (text.length <= 16000) {
    await postToMattermost(webhookUrl, {
      text,
      username: "NPM Package Tracker",
    });
    console.log("Successfully posted to Mattermost.");
  } else {
    // Split into multiple posts if needed
    await postToMattermost(webhookUrl, {
      text: title,
      username: "NPM Package Tracker",
    });

    const lines = table.split("\n");
    const header = lines[0] + "\n" + lines[1] + "\n";
    let chunk = header;

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if ((chunk + line + "\n").length > 15000) {
        await postToMattermost(webhookUrl, {
          text: chunk,
          username: "NPM Package Tracker",
        });
        chunk = header + line + "\n";
      } else {
        chunk += line + "\n";
      }
    }

    if (chunk.length > header.length) {
      await postToMattermost(webhookUrl, {
        text: chunk,
        username: "NPM Package Tracker",
      });
    }

    console.log("Successfully posted to Mattermost (multiple messages).");
  }
}
