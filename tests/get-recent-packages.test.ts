import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getRecentPackages } from "../src/get-recent-packages.js";

type Json = Record<string, unknown>;

function response(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(body: Buffer): Response {
  return new Response(body, { status: 200 });
}

function crateArchive(cargoToml: string): Buffer {
  const body = Buffer.from(cargoToml);
  const header = Buffer.alloc(512);
  header.write("pkg-0.1.0/Cargo.toml", 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(" ", 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
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
      if (url.pathname.endsWith("/download")) {
        return bytesResponse(crateArchive("[package]\nname = \"rust-good\"\n"));
      }

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
