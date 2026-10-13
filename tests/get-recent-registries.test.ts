import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { getRecentRustPackages } from "../src/get-recent-registries.js";

type Json = Record<string, unknown>;

function response(body: Json): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(body: Buffer, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers,
  });
}

function crateArchive(cargoToml: string): Buffer {
  return gzipSync(tarFile("pkg-0.1.0/Cargo.toml", cargoToml));
}

function tarFile(path: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(path, 0, "utf8");
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
  return Buffer.concat([header, body, padding, Buffer.alloc(1024)]);
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

    if (url.pathname.endsWith("/download")) {
      return bytesResponse(crateArchive("[package]\nname = \"new-good\"\n\n[[bin]]\nname = \"new-good\"\n"));
    }

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
    assert.equal(packages[0].hasBin, true);
    assert.deepEqual(packages[0].binSignals, ["cli"]);
    assert.equal(packages[0].publishedAt.toISOString(), "2026-10-11T00:00:00.000Z");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("rust provider applies shared search filters", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname.endsWith("/download")) {
      return bytesResponse(crateArchive("[package]\nname = \"matching\"\n"));
    }

    return (
    response({
      crates: [
        crate("matching", "2026-10-11T00:00:00Z", 2, {
          description: "serde helper",
        }),
        crate("boring", "2026-10-11T00:00:00Z", 2, {
          description: "plain crate",
        }),
      ],
    }));
  }) as typeof fetch;

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
    assert.deepEqual(packages[0].binSignals, []);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("rust provider clamps crates.io page size", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    assert.equal(url.hostname, "crates.io");

    if (url.pathname.endsWith("/download")) {
      return bytesResponse(crateArchive("[package]\nname = \"new-good\"\n"));
    }

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

test("rust provider detects gpui and tauri from crate Cargo.toml", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname.endsWith("/download")) {
      return bytesResponse(crateArchive(`
[package]
name = "app-crate"

[[bin]]
name = "app-crate"

[dependencies.gpui]
version = "0.1"

[dependencies.tauri]
version = "2"
`));
    }

    return response({
      crates: [
        crate("app-crate", "2026-10-11T00:00:00Z", 2),
      ],
    });
  }) as typeof fetch;

  try {
    const packages = await getRecentRustPackages({
      changesLimit: 10,
      maxPages: 1,
      maxResults: 10,
      daysBack: 7,
      now: Date.parse("2026-10-12T00:00:00Z"),
    });

    assert.deepEqual(packages[0].binSignals, ["cli", "gpui", "tauri"]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("rust provider skips oversized crate downloads", async () => {
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());

    if (url.pathname.endsWith("/download")) {
      return bytesResponse(Buffer.from("not read"), {
        "content-length": String(3 * 1024 * 1024),
      });
    }

    return response({
      crates: [
        crate("huge-crate", "2026-10-11T00:00:00Z", 2),
      ],
    });
  }) as typeof fetch;

  try {
    const packages = await getRecentRustPackages({
      changesLimit: 10,
      maxPages: 1,
      maxResults: 10,
      daysBack: 7,
      now: Date.parse("2026-10-12T00:00:00Z"),
    });

    assert.equal(packages[0].hasBin, false);
    assert.deepEqual(packages[0].binSignals, []);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
