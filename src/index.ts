import * as clack from "@clack/prompts";
import { getRecentPackages, type PackageInfo, type PackageProvider } from "./get-recent-packages.js";
import { postPackagesToMattermost } from "./mattermost-post.js";
import { parseCliArgs, printHelp } from "./cli-args.js";
import { parseDateRange, formatDaysAsRange } from "./date-parser.js";
import { isPackageProvider, PACKAGE_PROVIDERS } from "./package-types.js";
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

    const ecosystemIdx = headers.indexOf("Ecosystem");
    const nameIdx = headers.indexOf("Name");
    const versionIdx = headers.indexOf("Version");
    const descIdx = headers.indexOf("Description");
    const publishedIdx = headers.indexOf("Published");
    const versionsIdx = headers.indexOf("Versions");
    const binIdx = headers.indexOf("Bin");
    const cliIdx = headers.indexOf("Has CLI");
    const jsLinesIdx = headers.indexOf("JS Lines");
    const urlIdx = headers.indexOf("URL");
    const binSignals = binIdx === -1
      ? []
      : values[binIdx].split(",").map((value) => value.trim()).filter(Boolean);
    if (binSignals.length === 0 && values[cliIdx] === "Yes") {
      binSignals.push("cli");
    }

    if (nameIdx === -1 || versionIdx === -1) {
      throw new Error("CSV must have Name and Version columns");
    }

    packages.push({
      ecosystem: ecosystemIdx === -1 ? "npm" : (values[ecosystemIdx] as PackageInfo["ecosystem"]) || "npm",
      name: values[nameIdx] || "",
      version: values[versionIdx] || "",
      description: values[descIdx] || "",
      publishedAt: values[publishedIdx] ? new Date(values[publishedIdx]) : new Date(),
      npmUrl: values[urlIdx] || `https://www.npmjs.com/package/${values[nameIdx]}`,
      numberOfVersions: values[versionsIdx] ? parseInt(values[versionsIdx], 10) : 1,
      hasBin: binSignals.includes("cli") || values[cliIdx] === "Yes",
      binSignals,
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
    const prompt = `Research this software package and any technologies it integrates with. Then summarize in 10 words max. Sacrifice grammar for extreme brevity. Focus on what it does and what it integrates with, not quality.

Package: ${pkg.name}
Ecosystem: ${pkg.ecosystem}
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
  const rawArgs = process.argv.slice(2);
  const args = parseCliArgs(rawArgs);
  const promptForMissing = rawArgs.length === 0;

  if (args.help) {
    printHelp();
    return;
  }

  const webhookUrl = process.env.MATTERMOST_WEBHOOK_URL;

  clack.intro("Package Registry Search");

  if (!webhookUrl) {
    clack.log.warn("MATTERMOST_WEBHOOK_URL not set - results will not be posted to Mattermost");
  } else {
    clack.log.info("Results will be posted to Mattermost");
  }

  const csvFilePath = args.csvFile?.trim() ?? "";

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

      if (args.aiSummaries) {
        const claudeAvailable = await checkClaudeCodeAvailable();
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
      const newCsvPath = `out/package-report-${Date.now()}.csv`;
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
  let provider: PackageProvider = "npm";
  let dateRange = args.range;
  let partialMatch = args.partialMatch ?? true;
  let minJsLines = args.minJsLines;
  let maxResults = args.maxResults ?? 30;
  let changesLimit = args.changesLimit ?? 200;
  let maxPages = args.maxPages ?? 1000;
  let requireBin = args.requireBin ?? false;
  let requireDesktopApp = args.requireDesktopApp ?? false;

  if (args.provider !== undefined) {
    if (!isPackageProvider(args.provider)) {
      clack.log.error(`Unsupported provider: ${args.provider}. Use one of: ${PACKAGE_PROVIDERS.join(", ")}`);
      process.exit(1);
    }
    provider = args.provider;
  }

  // Interactive prompts for missing values
  if (promptForMissing && args.provider === undefined) {
    const providerInput = await clack.select({
      message: "Package registry provider",
      options: PACKAGE_PROVIDERS.map((value) => ({ value, label: value })),
      initialValue: "npm",
    });

    if (clack.isCancel(providerInput)) {
      clack.cancel("Operation cancelled.");
      process.exit(0);
    }

    provider = providerInput as PackageProvider;
  }

  if (promptForMissing && searchTerms === undefined) {
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

  if (promptForMissing && dateRange === undefined) {
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

  if (promptForMissing && searchTerms && searchTerms.trim().length > 0 && args.partialMatch === undefined) {
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

  if (promptForMissing && minJsLines === undefined) {
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

  if (promptForMissing && args.requireBin === undefined) {
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
  const parsedRange = parseDateRange(dateRange ?? "7d");
  const daysBack = parsedRange.days;

  const spinner = clack.spinner();
  if (provider === "all" && minJsLines !== undefined) {
    clack.log.warn("--min-js-lines applies only to npm packages in all-provider mode");
  } else if (provider !== "npm" && minJsLines !== undefined) {
    clack.log.warn("--min-js-lines is npm-only and will be ignored for this provider");
    minJsLines = undefined;
  }

  if (provider === "all" && requireBin) {
    clack.log.warn("--require-bin applies only to npm packages in all-provider mode");
  } else if (provider !== "npm" && requireBin) {
    clack.log.warn("--require-bin is npm-only and will be ignored for this provider");
    requireBin = false;
  }

  if (provider !== "rust" && provider !== "all" && requireDesktopApp) {
    clack.log.warn("--require-desktop-app is Rust-only and will be ignored for this provider");
    requireDesktopApp = false;
  }

  spinner.start(`Fetching recent ${provider} packages...`);

  try {
    const packages = await getRecentPackages({
      provider,
      changesLimit,
      maxResults,
      daysBack,
      searchTerms: searchTerms || "",
      partialMatch,
      minJsLines,
      maxPages,
      requireBin,
      requireDesktopApp,
    });

    spinner.stop("Search complete!");

    if (packages.length === 0) {
      clack.log.warn("No new packages found matching your criteria.");
      clack.outro("Done!");
      return;
    }

    clack.log.success(`Found ${packages.length} package(s)!`);

    if (args.aiSummaries) {
      const claudeAvailable = await checkClaudeCodeAvailable();
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
    const csvPath = `out/package-report-${Date.now()}.csv`;
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

function generateCsv(packages: PackageInfo[]): string {
  const hasJsLines = packages.some(pkg => pkg.jsLines !== undefined);

  const headers = hasJsLines
    ? ["Ecosystem", "Name", "Version", "Description", "Published", "Versions", "Bin", "JS Lines", "URL"]
    : ["Ecosystem", "Name", "Version", "Description", "Published", "Versions", "Bin", "URL"];

  const rows = packages.map((pkg) => {
    const binSignals = pkg.binSignals ?? (pkg.hasBin ? ["cli"] : []);
    const row = [
      escapeCsv(pkg.ecosystem),
      escapeCsv(pkg.name),
      escapeCsv(pkg.version),
      escapeCsv(pkg.description),
      pkg.publishedAt.toISOString().split("T")[0],
      pkg.numberOfVersions.toString(),
      escapeCsv(binSignals.join(",")),
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
