import assert from "node:assert/strict";
import test from "node:test";
import { getRecentPackages } from "../src/get-recent-packages.js";

type Json = Record<string, unknown>;

function response(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function npmPackument(name: string): Json {
  return {
    name,
    description: `${name} package`,
    "dist-tags": { latest: "1.0.1" },
    versions: {
      "1.0.0": { description: `${name} package` },
      "1.0.1": { description: `${name} package` },
    },
    time: {
      created: "2026-10-11T00:00:00.000Z",
      modified: "2026-10-11T00:00:00.000Z",
    },
  };
}

test("all provider combines npm and rust only", async () => {
  const oldFetch = globalThis.fetch;
  const hosts: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    hosts.push(url.hostname);

    if (url.hostname === "replicate.npmjs.com") {
      return response({
        last_seq: 101,
        results: [{ seq: 101, id: "npm-good" }],
      });
    }

    if (url.hostname === "registry.npmjs.org") {
      assert.equal(decodeURIComponent(url.pathname.slice(1)), "npm-good");
      return response(npmPackument("npm-good"));
    }

    if (url.hostname === "crates.io") {
      return response({
        crates: [
          {
            name: "rust-good",
            created_at: "2026-10-11T00:00:00Z",
            newest_version: "0.2.0",
            default_version: "0.2.0",
            num_versions: 2,
            description: "rust-good crate",
          },
          {
            name: "old-rust",
            created_at: "2020-01-01T00:00:00Z",
            newest_version: "0.2.0",
            default_version: "0.2.0",
            num_versions: 2,
            description: "old rust crate",
          },
        ],
      });
    }

    throw new Error(`unexpected fetch: ${url.toString()}`);
  }) as typeof fetch;

  try {
    const packages = await getRecentPackages({
      provider: "all",
      changesLimit: 2,
      maxPages: 1,
      maxResults: 10,
      daysBack: 7,
      concurrency: 1,
      npmStartSeq: 100,
      npmHeadSeq: 101,
      now: Date.parse("2026-10-12T00:00:00.000Z"),
    });

    assert.deepEqual(
      packages.map((pkg) => `${pkg.ecosystem}:${pkg.name}`),
      ["npm:npm-good", "rust:rust-good"]
    );
    assert.equal(hosts.includes("rubygems.org"), false);
    assert.equal(hosts.includes("index.golang.org"), false);
    assert.equal(hosts.includes("search.maven.org"), false);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
