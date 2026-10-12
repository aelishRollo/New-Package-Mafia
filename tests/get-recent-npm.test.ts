import assert from "node:assert/strict";
import test from "node:test";
import { getRecentNpmPackages } from "../src/get-recent-npm.js";

type Json = Record<string, unknown>;

function response(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function packument(
  name: string,
  created: string,
  versions: string[],
  extra: {
    modified?: string;
    description?: string;
    bin?: unknown;
  } = {}
): Json {
  const versionDocs: Json = {};
  for (const version of versions) {
    versionDocs[version] = {
      description: extra.description ?? `${name} description`,
      ...(extra.bin === undefined ? {} : { bin: extra.bin }),
    };
  }

  return {
    name,
    description: extra.description ?? `${name} description`,
    "dist-tags": { latest: versions[versions.length - 1] },
    versions: versionDocs,
    time: {
      created,
      modified: extra.modified ?? created,
    },
  };
}

test("npm scanner walks _changes forward and filters created packages", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  const packageFetches = new Map<string, number>();

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    calls.push(url.toString());

    if (url.hostname === "replicate.npmjs.com") {
      assert.equal(url.searchParams.get("descending"), null);
      assert.equal(url.searchParams.get("since"), "100");
      assert.equal(url.searchParams.get("limit"), "5");

      return response({
        last_seq: 110,
        results: [
          { seq: 101, id: "new-good" },
          { seq: 102, id: "old-updated" },
          { seq: 103, id: "single-version" },
          { seq: 104, id: "new-good" },
          { seq: 110, id: "_design/not-a-package" },
        ],
      });
    }

    assert.equal(url.hostname, "registry.npmjs.org");
    const name = decodeURIComponent(url.pathname.slice(1));
    packageFetches.set(name, (packageFetches.get(name) ?? 0) + 1);

    switch (name) {
      case "new-good":
        return response(
          packument(
            "new-good",
            "2026-10-10T00:00:00.000Z",
            ["1.0.0", "1.0.1"],
            { description: "useful cli", bin: { "new-good": "cli.js" } }
          )
        );
      case "old-updated":
        return response(
          packument(
            "old-updated",
            "2020-01-01T00:00:00.000Z",
            ["1.0.0", "2.0.0"],
            { modified: "2026-10-11T00:00:00.000Z" }
          )
        );
      case "single-version":
        return response(
          packument(
            "single-version",
            "2026-10-10T00:00:00.000Z",
            ["1.0.0"]
          )
        );
      default:
        throw new Error(`unexpected package fetch: ${name}`);
    }
  }) as typeof fetch;

  try {
    const packages = await getRecentNpmPackages({
      changesLimit: 5,
      maxResults: 10,
      daysBack: 7,
      concurrency: 1,
      npmStartSeq: 100,
      npmHeadSeq: 110,
      now: Date.parse("2026-10-12T00:00:00.000Z"),
    });

    assert.deepEqual(packages.map((pkg) => pkg.name), ["new-good"]);
    assert.equal(packages[0].numberOfVersions, 2);
    assert.equal(packages[0].hasBin, true);
    assert.equal(packageFetches.get("new-good"), 1);
    assert.equal(packageFetches.get("old-updated"), 1);
    assert.equal(packageFetches.get("single-version"), 1);
    assert.equal(
      calls.some((call) => {
        const url = new URL(call);
        return url.searchParams.get("descending") === "true" &&
          url.searchParams.has("since");
      }),
      false
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("npm scanner preserves search and requireBin filters", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.hostname === "replicate.npmjs.com") {
      return response({
        last_seq: 203,
        results: [
          { seq: 201, id: "matching-cli" },
          { seq: 202, id: "matching-no-cli" },
          { seq: 203, id: "boring-cli" },
        ],
      });
    }

    const name = decodeURIComponent(url.pathname.slice(1));
    switch (name) {
      case "matching-cli":
        return response(
          packument(
            "matching-cli",
            "2026-10-10T00:00:00.000Z",
            ["1.0.0", "1.1.0"],
            { description: "alpha tool", bin: "cli.js" }
          )
        );
      case "matching-no-cli":
        return response(
          packument(
            "matching-no-cli",
            "2026-10-10T00:00:00.000Z",
            ["1.0.0", "1.1.0"],
            { description: "alpha library" }
          )
        );
      case "boring-cli":
        return response(
          packument(
            "boring-cli",
            "2026-10-10T00:00:00.000Z",
            ["1.0.0", "1.1.0"],
            { description: "boring tool", bin: "cli.js" }
          )
        );
      default:
        throw new Error(`unexpected package fetch: ${name}`);
    }
  }) as typeof fetch;

  try {
    const packages = await getRecentNpmPackages({
      changesLimit: 10,
      maxResults: 10,
      daysBack: 7,
      concurrency: 1,
      searchTerms: "alpha",
      requireBin: true,
      npmStartSeq: 200,
      npmHeadSeq: 203,
      now: Date.parse("2026-10-12T00:00:00.000Z"),
    });

    assert.deepEqual(packages.map((pkg) => pkg.name), ["matching-cli"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
