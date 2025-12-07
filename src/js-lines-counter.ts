/**
 * Count JavaScript lines in an npm package by downloading and analyzing it.
 */

import { createWriteStream } from "fs";
import { mkdir, readdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { extract as tarExtract } from "tar";
import { tmpdir } from "os";

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

interface JsLinesResult {
  totalLines: number;
  fileCount: number;
}

/**
 * Download and extract a package tarball to count JS lines.
 */
export async function countJsLinesInPackage(
  packageName: string,
  version: string
): Promise<number> {
  const tempDir = join(tmpdir(), `npm-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    // Create temp directory
    await mkdir(tempDir, { recursive: true });

    // Get package metadata to find tarball URL
    const metadataUrl = `${NPM_REGISTRY_BASE}/${encodeURIComponent(packageName)}`;
    const metadataRes = await fetch(metadataUrl);

    if (!metadataRes.ok) {
      console.error(`Failed to fetch metadata for ${packageName}: ${metadataRes.status}`);
      return 0;
    }

    const metadata = await metadataRes.json();
    const versionData = metadata.versions?.[version];

    if (!versionData || !versionData.dist?.tarball) {
      console.error(`No tarball found for ${packageName}@${version}`);
      return 0;
    }

    const tarballUrl = versionData.dist.tarball;

    // Download tarball
    const tarballRes = await fetch(tarballUrl);

    if (!tarballRes.ok) {
      console.error(`Failed to download tarball for ${packageName}: ${tarballRes.status}`);
      return 0;
    }

    // Extract tarball
    const tarballPath = join(tempDir, "package.tgz");
    const extractDir = join(tempDir, "extracted");

    await mkdir(extractDir, { recursive: true });

    // Write tarball to disk
    const fileStream = createWriteStream(tarballPath);
    if (!tarballRes.body) {
      throw new Error(`No response body for ${packageName}`);
    }
    await pipeline(tarballRes.body, fileStream);

    // Extract using tar
    await tarExtract({
      file: tarballPath,
      cwd: extractDir,
    });

    // Count JS lines in extracted directory
    const result = await countJsLinesInDirectory(extractDir);
    return result.totalLines;

  } catch (error) {
    console.error(`Error counting JS lines for ${packageName}@${version}:`, error);
    return 0;
  } finally {
    // Cleanup temp directory
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Recursively count lines in all .js, .jsx, .ts, .tsx files in a directory.
 */
async function countJsLinesInDirectory(dirPath: string): Promise<JsLinesResult> {
  let totalLines = 0;
  let fileCount = 0;

  async function processDirectory(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and hidden directories
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
          continue;
        }
        await processDirectory(fullPath);
      } else if (entry.isFile()) {
        // Check if it's a JS/TS file
        if (/\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(entry.name)) {
          try {
            const content = await readFile(fullPath, "utf-8");
            const lines = content.split("\n").length;
            totalLines += lines;
            fileCount++;
          } catch (error) {
            // Skip files we can't read
          }
        }
      }
    }
  }

  await processDirectory(dirPath);

  return { totalLines, fileCount };
}
