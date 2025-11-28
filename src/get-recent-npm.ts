// npm-single-version.js
// Fetch recent-ish packages from the npm search API
// and keep only those with exactly ONE published version.

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const REGISTRY_URL = 'https://registry.npmjs.org';

// How many results to fetch from search
const PAGE_SIZE = 50;
// Change this to adjust which packages you see,
// e.g. 'is:public', 'react', 'author:you', etc.
const SEARCH_TEXT = 'is:public';

async function getPackagesFromSearch({ size = PAGE_SIZE, from = 0, text = SEARCH_TEXT } = {}) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set('text', text);
  url.searchParams.set('size', String(size));
  url.searchParams.set('from', String(from));

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Search failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  // data.objects[i].package.name
  return data.objects.map(obj => obj.package.name);
}

async function packageHasSingleVersion(pkgName) {
  // Ask only for "versions" field to keep response small
  const url = `${REGISTRY_URL}/${encodeURIComponent(pkgName)}?fields=versions`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Failed to fetch ${pkgName}: ${res.status} ${res.statusText}`);
    return false;
  }

  const data = await res.json();
  const versions = data.versions || {};
  const count = Object.keys(versions).length;

  return count === 1;
}

async function main() {
  console.log(`Fetching packages from npm search for text="${SEARCH_TEXT}"...`);
  const packageNames = await getPackagesFromSearch();

  console.log(`Got ${packageNames.length} packages. Checking versions...`);

  // Check all packages in parallel
  const results = await Promise.all(
    packageNames.map(async (name) => ({
      name,
      singleVersion: await packageHasSingleVersion(name),
    }))
  );

  const singleVersionPackages = results
    .filter(r => r.singleVersion)
    .map(r => r.name);

  console.log('Packages with exactly ONE version:');
  singleVersionPackages.forEach(name => console.log(`- ${name}`));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
