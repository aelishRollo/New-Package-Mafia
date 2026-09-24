import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../src/cli-args.js";
import { isWithinDays, normalizeDescription, passesCommonFilters } from "../src/provider-utils.js";
import type { PackageInfo } from "../src/package-types.js";

function pkg(overrides: Partial<PackageInfo> = {}): PackageInfo {
  return {
    ecosystem: "rust",
    name: "serde-extra",
    version: "0.2.0",
    description: "Serde helper crate",
    publishedAt: new Date("2026-09-20T00:00:00Z"),
    npmUrl: "https://example.test/serde-extra",
    numberOfVersions: 2,
    hasBin: false,
    ...overrides,
  };
}

test("parseCliArgs reads provider flag", () => {
  assert.equal(parseCliArgs(["--provider", "rust"]).provider, "rust");
  assert.equal(parseCliArgs(["-p", "java"]).provider, "java");
});

test("isWithinDays rejects old and future dates", () => {
  const now = Date.parse("2026-09-24T00:00:00Z");
  assert.equal(isWithinDays(new Date("2026-09-20T00:00:00Z"), 7, now), true);
  assert.equal(isWithinDays(new Date("2026-09-01T00:00:00Z"), 7, now), false);
  assert.equal(isWithinDays(new Date("2026-09-25T00:00:00Z"), 7, now), false);
});

test("normalizeDescription keeps output single-line", () => {
  assert.equal(normalizeDescription("one\ntwo\tthree"), "one two three");
  assert.equal(normalizeDescription(undefined), "");
});

test("passesCommonFilters applies search terms to name or description", () => {
  assert.equal(passesCommonFilters(pkg(), { searchTerms: "serde" }), true);
  assert.equal(passesCommonFilters(pkg(), { searchTerms: "helper" }), true);
  assert.equal(passesCommonFilters(pkg(), { searchTerms: "missing" }), false);
});

test("passesCommonFilters honors requireBin", () => {
  assert.equal(passesCommonFilters(pkg({ hasBin: false }), { requireBin: true }), false);
  assert.equal(passesCommonFilters(pkg({ hasBin: true }), { requireBin: true }), true);
});

