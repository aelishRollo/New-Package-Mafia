import * as clack from "@clack/prompts";
import { getRecentNpmPackages, type PackageInfo } from "./get-recent-npm.js";
import { postPackagesToMattermost } from "./mattermost-post.js";
import { parseCliArgs, printHelp } from "./cli-args.js";
import { parseDateRange, formatDaysAsRange } from "./date-parser.js";
import { writeFile, readFile, access, mkdir } from "fs/promises";
import { exec, spawn } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function parseCsvFile(filePath: string): Promise<PackageInfo[]> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n").filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error("CSV file is empty or has no data rows");
  }

  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const packages: PackageInfo[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);

    const nameIdx = headers.indexOf("Name");
    const versionIdx = headers.indexOf("Version");
    const descIdx = headers.indexOf("Description");
    const publishedIdx = headers.indexOf("Published");
    const versionsIdx = headers.indexOf("Versions");
    const cliIdx = headers.indexOf("Has CLI");
    const jsLinesIdx = headers.indexOf("JS Lines");
    const urlIdx = headers.indexOf("URL");

    if (nameIdx === -1 || versionIdx === -1) {
      throw new Error("CSV must have Name and Version columns");
    }

    packages.push({
      name: values[nameIdx] || "",
      version: values[versionIdx] || "",
      description: values[descIdx] || "",
      publishedAt: values[publishedIdx] ? new Date(values[publishedIdx]) : new Date(),
      npmUrl: values[urlIdx] || `https://www.npmjs.com/package/${values[nameIdx]}`,
      numberOfVersions: values[versionsIdx] ? parseInt(values[versionsIdx], 10) : 1,
      hasBin: values[cliIdx] === "Yes",
      jsLines: values[jsLinesIdx] ? parseInt(values[jsLinesIdx], 10) : undefined,
    });
  }

  return packages;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}

async function checkClaudeCodeAvailable(): Promise<boolean> {
  try {
    await execAsync("claude --version", {
      env: { ...process.env, PATH: process.env.PATH },
    });
    return true;
  } catch {
    return false;
  }
}

async function generateAiSummaries(packages: PackageInfo[]): Promise<void> {
  console.log("\nAI Summaries:\n");

  for (const pkg of packages) {
    const prompt = `Research this npm package and any technologies it integrates with. Then summarize in 10 words max. Sacrifice grammar for extreme brevity. Focus on what it does and what it integrates with, not quality.

Package: ${pkg.name}
Description: ${pkg.description}
URL: ${pkg.npmUrl}

Response format: Just the summary, nothing else.`;

    console.log(`\n• ${pkg.name}:`);

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "claude",
          ["--dangerously-skip-permissions", "--print", "--model", "haiku", prompt],
          {
            env: { ...process.env, PATH: process.env.PATH },
          }
        );

        let summary = "";

        child.stdout.on("data", (data: Buffer) => {
          const text = data.toString();
          summary += text;
          process.stdout.write(text);
        });

        child.stderr.on("data", (data: Buffer) => {
          process.stderr.write(data);
        });

        child.on("close", (code) => {
          if (code === 0) {
            pkg.aiSummary = summary.trim();
            process.stdout.write("\n");
            resolve();
          } else {
            console.log("[Summary failed]");
            reject(new Error(`Process exited with code ${code}`));
          }
        });

        child.on("error", (err) => {
          console.log("[Summary failed]");
          reject(err);
        });
      });
    } catch (err) {
      // Error already logged above
    }
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const webhookUrl = process.env.MATTERMOST_WEBHOOK_URL;

  clack.intro("NPM Package Search");

  if (!webhookUrl) {
    clack.log.warn("MATTERMOST_WEBHOOK_URL not set - results will not be posted to Mattermost");
  } else {
    clack.log.info("Results will be posted to Mattermost");
  }

  // First question: ask if they want to process an existing CSV
  const csvFileInput = await clack.text({
    message: "Process existing CSV file? (leave empty to search for new packages)",
    placeholder: "e.g., out/npm-packages-1234567890.csv",
    defaultValue: "",
  });

  if (clack.isCancel(csvFileInput)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }

  const csvFilePath = (csvFileInput as string).trim();

  // If CSV file provided, load it and skip to summary selection
  if (csvFilePath) {
    // Check if file exists
    try {
      await access(csvFilePath);
    } catch {
      clack.log.error(`File not found: ${csvFilePath}`);
      process.exit(1);
    }

    try {
      const packages = await parseCsvFile(csvFilePath);
      clack.log.success(`Loaded ${packages.length} package(s) from CSV!`);

      // Check if Claude Code is available before asking
      const claudeAvailable = await checkClaudeCodeAvailable();

      // Ask if user wants AI summaries
      const wantsSummaries = await clack.confirm({
        message: claudeAvailable
          ? "Generate AI summaries for selected packages?"
          : "Generate AI summaries for selected packages? (Note: Claude Code CLI not detected)",
        initialValue: false,
      });

      if (clack.isCancel(wantsSummaries)) {
        clack.cancel("Operation cancelled.");
        process.exit(0);
      }

      if (wantsSummaries) {
        if (!claudeAvailable) {
          clack.log.error("Claude Code CLI not found. Please install it or ensure it's in your PATH.");
          clack.log.info("Install from: https://github.com/anthropics/claude-code");
          clack.outro("Done!");
          return;
        }

        // Let user select which packages to summarize
        const packageChoices = packages.map((pkg, idx) => ({
          value: idx,
          label: `${pkg.name} - ${pkg.description.substring(0, 60)}${pkg.description.length > 60 ? '...' : ''}`,
        }));

        const selectedIndices = await clack.multiselect({
          message: "Select packages to summarize (space to select, enter to confirm)",
          options: packageChoices,
          required: false,
        });

        if (clack.isCancel(selectedIndices)) {
          clack.cancel("Operation cancelled.");
          process.exit(0);
        }

        if (selectedIndices && (selectedIndices as number[]).length > 0) {
          const selectedPackages = (selectedIndices as number[]).map(idx => packages[idx]);
          const spinner = clack.spinner();
          spinner.start("Generating AI summaries...");
          try {
            await generateAiSummaries(selectedPackages);
            spinner.stop("AI summaries generated!");
          } catch (err) {
            spinner.stop("Failed to generate summaries");
            clack.log.warn(`Could not generate summaries: ${(err as Error).message}`);
          }
        }
      }

      // Generate new CSV with updated data
      await mkdir("out", { recursive: true });
      const newCsvPath = `out/npm-packages-${Date.now()}.csv`;
      const csvContent = generateCsv(packages);
      await writeFile(newCsvPath, csvContent, "utf-8");
      clack.log.info(`New CSV file saved: ${newCsvPath}`);

      if (webhookUrl) {
        const spinner = clack.spinner();
        spinner.start("Posting to Mattermost...");
        await postPackagesToMattermost(packages, webhookUrl);
        spinner.stop("Posted to Mattermost!");
      }

      clack.outro("Done!");
      return;
    } catch (err) {
      clack.log.error(`Failed to process CSV: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  let searchTerms = args.search;
  let dateRange = args.range;
  let partialMatch = args.partialMatch ?? true;
  let minJsLines = args.minJsLines;
  let maxResults = args.maxResults ?? 30;
  let changesLimit = args.changesLimit ?? 200;
  let maxPages = args.maxPages ?? 1000;
  let requireBin = args.requireBin ?? false;

  // Interactive prompts for missing values
  if (searchTerms === undefined) {
    const searchInput = await clack.text({
      message: "Search for packages by name or description (leave empty to skip)",
      placeholder: "e.g., react typescript",
      defaultValue: "",
    });

    if (clack.isCancel(searchInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    searchTerms = searchInput as string;
  }

  if (dateRange === undefined) {
    const rangeInput = await clack.text({
      message: "Date range for packages",
      placeholder: "e.g., 7d, 2w, 1m, 2y",
      defaultValue: "7d",
      validate: (value) => {
        if (!value || value.trim() === "") return; // Allow empty to use default
        try {
          parseDateRange(value);
        } catch (err) {
          return (err as Error).message;
        }
      },
    });

    if (clack.isCancel(rangeInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    dateRange = (rangeInput as string).trim() || "7d";
  }

  if (searchTerms && searchTerms.trim().length > 0 && args.partialMatch === undefined) {
    const partialMatchInput = await clack.confirm({
      message: "Enable partial word matching? (e.g., 'react' matches 'reactivity')",
      initialValue: true,
    });

    if (clack.isCancel(partialMatchInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    partialMatch = partialMatchInput as boolean;
  }

  if (minJsLines === undefined) {
    const jsLinesInput = await clack.text({
      message: "Minimum JavaScript lines (leave empty to skip this filter)",
      placeholder: "e.g., 100, 500, 1000",
      defaultValue: "",
      validate: (value) => {
        if (!value || value.trim() === "") return;
        const num = parseInt(value, 10);
        if (Number.isNaN(num) || num < 0) {
          return "Must be a positive number or empty";
        }
      },
    });

    if (clack.isCancel(jsLinesInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    const jsLinesStr = jsLinesInput as string;
    minJsLines = jsLinesStr && jsLinesStr.trim() ? parseInt(jsLinesStr, 10) : undefined;
  }

  if (args.requireBin === undefined) {
    const binInput = await clack.confirm({
      message: "Only show packages with CLI binaries?",
      initialValue: false,
    });

    if (clack.isCancel(binInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    requireBin = binInput as boolean;
  }

  // Parse date range
  const parsedRange = parseDateRange(dateRange);
  const daysBack = parsedRange.days;

  const spinner = clack.spinner();
  spinner.start("Fetching recent npm packages...");

  try {
    const packages = await getRecentNpmPackages({
      changesLimit,
      maxResults,
      daysBack,
      searchTerms: searchTerms || "",
      partialMatch,
      minJsLines,
      maxPages,
      requireBin,
    });

    spinner.stop("Search complete!");

    if (packages.length === 0) {
      clack.log.warn("No new packages found matching your criteria.");
      clack.outro("Done!");
      return;
    }

    clack.log.success(`Found ${packages.length} package(s)!`);

    // Check if Claude Code is available before asking
    const claudeAvailable = await checkClaudeCodeAvailable();

    // Ask if user wants AI summaries
    const wantsSummaries = await clack.confirm({
      message: claudeAvailable
        ? "Generate AI summaries for selected packages?"
        : "Generate AI summaries for selected packages? (Note: Claude Code CLI not detected)",
      initialValue: false,
    });

    if (clack.isCancel(wantsSummaries)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    if (wantsSummaries) {
      if (!claudeAvailable) {
        clack.log.error("Claude Code CLI not found. Please install it or ensure it's in your PATH.");
        clack.log.info("Install from: https://github.com/anthropics/claude-code");
      } else {
        // Let user select which packages to summarize
        const packageChoices = packages.map((pkg, idx) => ({
          value: idx,
          label: `${pkg.name} - ${pkg.description.substring(0, 60)}${pkg.description.length > 60 ? '...' : ''}`,
        }));

        const selectedIndices = await clack.multiselect({
          message: "Select packages to summarize (space to select, enter to confirm)",
          options: packageChoices,
          required: false,
        });

        if (clack.isCancel(selectedIndices)) {
          clack.cancel("Operation cancelled.");
          process.exit(0);
        }

        if (selectedIndices && (selectedIndices as number[]).length > 0) {
          const selectedPackages = (selectedIndices as number[]).map(idx => packages[idx]);
          spinner.start("Generating AI summaries...");
          try {
            await generateAiSummaries(selectedPackages);
            spinner.stop("AI summaries generated!");
          } catch (err) {
            spinner.stop("Failed to generate summaries");
            clack.log.warn(`Could not generate summaries: ${(err as Error).message}`);
          }
        }
      }
    }

    // Generate CSV
    await mkdir("out", { recursive: true });
    const csvPath = `out/npm-packages-${Date.now()}.csv`;
    const csvContent = generateCsv(packages);
    await writeFile(csvPath, csvContent, "utf-8");
    clack.log.info(`CSV file saved: ${csvPath}`);

    if (webhookUrl) {
      spinner.start("Posting to Mattermost...");
      await postPackagesToMattermost(packages, webhookUrl);
      spinner.stop("Posted to Mattermost!");
    }

    clack.outro("Done!");
  } catch (err) {
    spinner.stop("Error occurred");
    throw err;
  }
}

function generateCsv(packages: { name: string; version: string; description: string; publishedAt: Date; npmUrl: string; numberOfVersions: number; jsLines?: number; hasBin?: boolean }[]): string {
  const hasJsLines = packages.some(pkg => pkg.jsLines !== undefined);

  const headers = hasJsLines
    ? ["Name", "Version", "Description", "Published", "Versions", "Has CLI", "JS Lines", "URL"]
    : ["Name", "Version", "Description", "Published", "Versions", "Has CLI", "URL"];

  const rows = packages.map((pkg) => {
    const row = [
      escapeCsv(pkg.name),
      escapeCsv(pkg.version),
      escapeCsv(pkg.description),
      pkg.publishedAt.toISOString().split("T")[0],
      pkg.numberOfVersions.toString(),
      pkg.hasBin ? "Yes" : "No",
    ];

    if (hasJsLines) {
      row.push(pkg.jsLines?.toString() || "0");
    }

    row.push(pkg.npmUrl);

    return row.join(",");
  });

  return [headers.join(","), ...rows].join("\n");
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

main().catch((err) => {
  clack.log.error("Fatal error:");
  console.error(err);
  process.exit(1);
});
