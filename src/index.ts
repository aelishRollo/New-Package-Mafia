import { getRecentNpmPackages } from "./get-recent-npm.js";
import { postPackagesToMattermost } from "./mattermost-post.js";

async function main() {
  const webhookUrl = process.env.MATTERMOST_WEBHOOK_URL;

  if (!webhookUrl) {
    console.error("Error: MATTERMOST_WEBHOOK_URL environment variable is required.");
    process.exit(1);
  }

  console.log("Fetching recent npm packages...");
  const packages = await getRecentNpmPackages({
    changesLimit: 200,
    maxResults: 30,
    daysBack: 7,
  });

  if (packages.length === 0) {
    console.log("No new packages found.");
    return;
  }

  console.log(`\nFound ${packages.length} packages. Posting to Mattermost...`);
  await postPackagesToMattermost(packages, webhookUrl);

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
