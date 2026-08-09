import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distribution = path.join(repositoryRoot, "apps/web/dist");
const indexPath = path.join(distribution, "index.html");
const manifestPath = path.join(distribution, ".vite/manifest.json");
const evidencePath = path.join(distribution, ".vite/capstone-bundle-evidence.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  });
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is missing or invalid; rebuild apps/web before generating its report.`);
  }
}

function totals(selectedAssets) {
  return {
    assetCount: selectedAssets.length,
    gzipBytes: selectedAssets.reduce((total, asset) => total + asset.gzipBytes, 0),
    rawBytes: selectedAssets.reduce((total, asset) => total + asset.rawBytes, 0),
  };
}

if (!statSync(distribution, { throwIfNoEntry: false })?.isDirectory()) {
  fail("Build apps/web before generating its bundle report.");
}

const manifest = readJson(manifestPath, "The Vite manifest");
const evidence = readJson(evidencePath, "The Capstone bundle evidence");
if (evidence.schemaVersion !== 1 || !Array.isArray(evidence.chunks)) {
  fail("The Capstone bundle evidence has an unsupported shape.");
}

const chunksByFile = new Map(evidence.chunks.map((chunk) => [chunk.file, chunk]));
const entryChunks = evidence.chunks.filter((chunk) => chunk.isEntry === true);
if (entryChunks.length !== 1) {
  fail("The production bundle must contain exactly one initial JavaScript entry.");
}

const initialChunkNames = new Set();
const pendingChunks = [entryChunks[0].file];
while (pendingChunks.length > 0) {
  const file = pendingChunks.pop();
  if (file === undefined || initialChunkNames.has(file)) {
    continue;
  }
  const chunk = chunksByFile.get(file);
  if (chunk === undefined || !Array.isArray(chunk.imports)) {
    fail(`Bundle evidence references a missing static import: ${String(file)}`);
  }
  initialChunkNames.add(file);
  pendingChunks.push(...chunk.imports);
}

const administrationModules = evidence.chunks.flatMap((chunk) =>
  chunk.modules
    .filter((module) => module.startsWith("apps/web/src/administration/"))
    .map((module) => ({ chunk: chunk.file, module })),
);
if (administrationModules.length === 0) {
  fail("Bundle evidence did not contain the administration route modules.");
}
const initialAdministration = administrationModules.find(({ chunk }) =>
  initialChunkNames.has(chunk),
);
if (initialAdministration !== undefined) {
  fail(
    `Administration module ${initialAdministration.module} is reachable from the initial chunk.`,
  );
}

const manifestByFile = new Map(
  Object.values(manifest)
    .filter((entry) => typeof entry?.file === "string")
    .map((entry) => [entry.file, entry]),
);
const initialAssetNames = new Set(["index.html", ...initialChunkNames]);
for (const file of initialChunkNames) {
  const entry = manifestByFile.get(file);
  for (const related of [...(entry?.css ?? []), ...(entry?.assets ?? [])]) {
    initialAssetNames.add(related);
  }
}

const indexHtml = readFileSync(indexPath, "utf8");
for (const match of indexHtml.matchAll(/(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/gu)) {
  const reference = match[1];
  if (reference !== undefined && !/^(?:data:|https?:|\/\/)/u.test(reference)) {
    initialAssetNames.add(reference.replace(/^\//u, ""));
  }
}

const assets = filesBelow(distribution)
  .map((file) => path.relative(distribution, file).split(path.sep).join("/"))
  .filter((file) => !file.startsWith(".vite/"))
  .map((file) => {
    const contents = readFileSync(path.join(distribution, file));
    return {
      file,
      gzipBytes: gzipSync(contents).byteLength,
      rawBytes: contents.byteLength,
    };
  })
  .sort((left, right) => right.rawBytes - left.rawBytes || left.file.localeCompare(right.file));
const assetNames = new Set(assets.map(({ file }) => file));
for (const file of initialAssetNames) {
  if (!assetNames.has(file)) {
    fail(`The initial page references a missing emitted asset: ${file}`);
  }
}
const initialAssets = assets.filter(({ file }) => initialAssetNames.has(file));
const deferredAssets = assets.filter(({ file }) => !initialAssetNames.has(file));

const builtJavaScript = assets
  .filter(({ file }) => file.endsWith(".js"))
  .map(({ file }) => readFileSync(path.join(distribution, file), "utf8"))
  .join("\n");
if (builtJavaScript.includes("jsx-dev-runtime") || /\/(?:Users|home)\//u.test(builtJavaScript)) {
  fail("The production web build contains development JSX or local source paths.");
}

const report = {
  generatedAt: new Date().toISOString(),
  routeSplit: {
    administrationChunkCount: new Set(administrationModules.map(({ chunk }) => chunk)).size,
    administrationModuleCount: administrationModules.length,
    evidence: path.relative(distribution, evidencePath),
    initialChunkCount: initialChunkNames.size,
    manifest: path.relative(distribution, manifestPath),
  },
  initial: {
    ...totals(initialAssets),
    assets: initialAssets,
  },
  deferred: {
    ...totals(deferredAssets),
    assets: deferredAssets,
  },
  largestAsset: assets[0] ?? null,
  totals: totals(assets),
  assets,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
