import assert from "node:assert/strict";
import test from "node:test";
import { toMarkdownTable } from "../src/mattermost-post.js";
import type { PackageInfo } from "../src/package-types.js";

function pkg(
  name: string,
  ecosystem: PackageInfo["ecosystem"] = "npm",
  binSignals: string[] = []
): PackageInfo {
  return {
    ecosystem,
    name,
    version: "1.0.1",
    description: `${name} package`,
    publishedAt: new Date("2026-10-12T00:00:00Z"),
    npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
    numberOfVersions: 2,
    hasBin: binSignals.includes("cli"),
    binSignals,
  };
}

test("toMarkdownTable orders packages by name ascending", () => {
  const table = toMarkdownTable([
    pkg("zeta"),
    pkg("@scope/bravo"),
    pkg("Alpha"),
  ]);

  const lines = table.split("\n");
  const rows = lines.slice(2);

  assert.match(lines[0], /\| Bin \|/);
  assert.match(rows[0], /\[@scope\/bravo\]/);
  assert.match(rows[1], /\[Alpha\]/);
  assert.match(rows[2], /\[zeta\]/);
});

test("toMarkdownTable renders bin signals", () => {
  const table = toMarkdownTable([
    pkg("app", "rust", ["cli", "gpui", "tauri"]),
  ]);

  assert.match(table, /\| rust \| \[app\].*\| cli,gpui,tauri \|/);
});

test("toMarkdownTable lists npm packages before rust packages", () => {
  const table = toMarkdownTable([
    pkg("aaa-rust", "rust"),
    pkg("zzz-npm", "npm"),
    pkg("bbb-rust", "rust"),
    pkg("aaa-npm", "npm"),
  ]);

  const rows = table.split("\n").slice(2);

  assert.match(rows[0], /\| npm \| \[aaa-npm\]/);
  assert.match(rows[1], /\| npm \| \[zzz-npm\]/);
  assert.match(rows[2], /\| rust \| \[aaa-rust\]/);
  assert.match(rows[3], /\| rust \| \[bbb-rust\]/);
});
