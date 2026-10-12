import assert from "node:assert/strict";
import test from "node:test";
import { getRecentRustPackages } from "../src/get-recent-registries.js";

type Json = Record<string, unknown>;

function response(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function crate(
  name: string,
  createdAt: string,
  numVersions: number,
  extra: {
    newestVersion?: string;
    description?: string;
  } = {}
): Json {
  return {
    name,
    created_at: createdAt,
    newest_version: extra.newestVersion ?? "0.1.1",
    default_version: extra.newestVersion ?? "0.1.1",
    num_versions: numVersions,
    description: extra.description ?? `${name} crate`,
  };
}

test("rust provider keeps crates created in range with multiple versions", async () => {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    calls.push(url.toString());

    assert.equal(url.hostname, "crates.io");
    assert.equal(url.pathname, "/api/v1/crates");
    assert.equal(url.searchParams.get("sort"), "new");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("per_page"), "3");

    return response({
      crates: [
        crate("new-good", "2026-10-11T00:00:00Z", 2, {
          newestVersion: "0.2.0",
          description: "alpha command runner",
        }),
        crate("single-version", "2026-10-11T00:00:00Z", 1),
        crate("old-good", "2026-09-01T00:00:00Z", 2),
      ],
    });
  }) as typeof fetch;

  try {
    const packages = await getRecentRustPackages({
      changesLimit: 3,
      maxPages: 2,
      maxResults: 10,
      daysBack: 7,
      now: Date.parse("2026-10-12T00:00:00Z"),
    });

    assert.deepEqual(packages.map((pkg) => pkg.name), ["new-good"]);
    assert.equal(packages[0].ecosystem, "rust");
    assert.equal(packages[0].version, "0.2.0");
    assert.equal(packages[0].numberOfVersions, 2);
    assert.equal(packages[0].publishedAt.toISOString(), "2026-10-11T00:00:00.000Z");
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("rust provider applies shared search filters", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    response({
      crates: [
        crate("matching", "2026-10-11T00:00:00Z", 2, {
          description: "serde helper",
        }),
        crate("boring", "2026-10-11T00:00:00Z", 2, {
          description: "plain crate",
        }),
      ],
    })) as typeof fetch;

  try {
    const packages = await getRecentRustPackages({
      changesLimit: 10,
      maxPages: 1,
      maxResults: 10,
      daysBack: 7,
      searchTerms: "serde",
      now: Date.parse("2026-10-12T00:00:00Z"),
    });

    assert.deepEqual(packages.map((pkg) => pkg.name), ["matching"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("rust provider clamps crates.io page size", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    assert.equal(url.hostname, "crates.io");
    assert.equal(url.searchParams.get("per_page"), "100");

    return response({
      crates: [
        crate("new-good", "2026-10-11T00:00:00Z", 2),
      ],
    });
  }) as typeof fetch;

  try {
    const packages = await getRecentRustPackages({
      changesLimit: 10_000,
      maxPages: 1,
      maxResults: 10,
      daysBack: 7,
      now: Date.parse("2026-10-12T00:00:00Z"),
    });

    assert.deepEqual(packages.map((pkg) => pkg.name), ["new-good"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
