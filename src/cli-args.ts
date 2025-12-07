/**
 * Parse command-line arguments for non-interactive mode.
 */

export interface CliArgs {
  help?: boolean;
  search?: string;
  range?: string;
  partialMatch?: boolean;
  minJsLines?: number;
  maxResults?: number;
  changesLimit?: number;
  maxPages?: number;
  requireBin?: boolean;
}

export function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;

      case "--search":
      case "-s":
        result.search = args[++i];
        break;

      case "--range":
      case "-r":
        result.range = args[++i];
        break;

      case "--partial-match":
        result.partialMatch = args[++i]?.toLowerCase() !== "false";
        break;

      case "--min-js-lines":
        result.minJsLines = parseInt(args[++i], 10);
        break;

      case "--max-results":
        result.maxResults = parseInt(args[++i], 10);
        break;

      case "--changes-limit":
        result.changesLimit = parseInt(args[++i], 10);
        break;

      case "--max-pages":
        result.maxPages = parseInt(args[++i], 10);
        break;

      case "--require-bin":
        result.requireBin = true;
        break;
    }
  }

  return result;
}

export function printHelp(): void {
  console.log(`
NPM Package Search Tool

Usage:
  pnpm start [options]

Options:
  --help, -h              Show this help message
  --search, -s <terms>    Search for packages by name or description (AND logic)
                          Searches both package name and description fields
                          Example: --search "react typescript"
  --range, -r <range>     Date range for packages (default: 7d)
                          Formats: 3d (days), 2w (weeks), 1m (months), 2y (years), or plain number
                          Examples: --range 2w, --range 30, --range 1m
  --partial-match <bool>  Enable partial word matching (default: true)
                          Example: --partial-match false
  --min-js-lines <num>    Minimum JavaScript lines required in package
                          Example: --min-js-lines 100
  --max-results <num>     Maximum number of results to return (default: 30)
  --changes-limit <num>   Number of packages to fetch per page (default: 200)
  --max-pages <num>       Maximum number of pages to fetch (default: 1000)
                          The tool will automatically page through the changes feed
                          until it finds enough matching packages or hits this limit
  --require-bin           Only show packages with CLI bin entries (executables)

Examples:
  # Interactive mode (prompts for all options)
  pnpm start

  # Search for React packages from last 2 weeks
  pnpm start --search "react" --range 2w

  # Find TypeScript packages with at least 500 lines of JS
  pnpm start --search "typescript" --min-js-lines 500

  # Get packages from last month, max 50 results
  pnpm start --range 1m --max-results 50

Environment:
  MATTERMOST_WEBHOOK_URL  Optional: Webhook URL for posting results to Mattermost
                          If not set, results will only be displayed locally

Note:
  AI summaries require Claude Code CLI to be installed and authenticated
  Install from: https://github.com/anthropics/claude-code
`);
}
