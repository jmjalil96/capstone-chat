import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (listed.status !== 0) {
  process.stderr.write("Could not enumerate repository files for the boundary audit.\n");
  process.exit(1);
}

const files = listed.stdout.split("\0").filter(Boolean);
const violations = [];
const sourceExtension = /\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const importPattern =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*)(["'])([^"']+)\1/gu;
const literalSecretPatterns = [
  new RegExp(`\\b${["sk", "or", "v1"].join("-")}-[A-Za-z0-9_-]{16,}\\b`, "u"),
  new RegExp(`\\b${["r", "e"].join("")}_[A-Za-z0-9]{20,}\\b`, "u"),
  new RegExp(`\\b${["NRAK", ""].join("-")}[A-Za-z0-9]{16,}\\b`, "u"),
  new RegExp(`\\b${["g", "h"].join("")}[pousr]_[A-Za-z0-9]{36,255}\\b`, "u"),
  new RegExp(`\\b${["github", "pat"].join("_")}_[A-Za-z0-9_]{40,255}\\b`, "u"),
  new RegExp(`\\b${["r", "n", "d"].join("")}_[A-Za-z0-9]{24,255}\\b`, "u"),
  new RegExp(`\\b${["AK", "IA"].join("")}[0-9A-Z]{16}\\b`, "u"),
  new RegExp(`-----${"BEGIN"} (?:EC |OPENSSH |RSA )?${["PRIVATE", "KEY"].join(" ")}-----`, "u"),
];
const forbiddenDependencies = [
  "@newrelic/browser-agent",
  "@opentelemetry/auto-instrumentations-node",
  "@opentelemetry/sdk-node",
  "@sentry/node",
  "@sentry/react",
  "bull",
  "bullmq",
  "ioredis",
  "newrelic",
  "redis",
  "resend",
];

function record(file, reason) {
  violations.push(`${file}: ${reason}`);
}

function resolveImport(file, specifier) {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  return path.relative(repositoryRoot, path.resolve(repositoryRoot, path.dirname(file), specifier));
}

function textContents(file) {
  const contents = readFileSync(path.join(repositoryRoot, file));
  if (contents.includes(0) || !isUtf8(contents)) {
    return null;
  }
  return contents.toString("utf8");
}

for (const file of files) {
  const contents = textContents(file);
  if (contents === null) {
    continue;
  }

  for (const pattern of literalSecretPatterns) {
    if (pattern.test(contents)) {
      record(file, "contains a credential-shaped literal");
    }
  }

  if (file.startsWith("apps/api/src/") && contents.includes("process.env")) {
    if (file !== "apps/api/src/config.ts" && file !== "apps/api/src/environment.ts") {
      record(file, "reads process.env outside the API configuration boundary");
    }
  }

  if (!sourceExtension.test(file)) {
    continue;
  }
  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[2];
    if (specifier === undefined) {
      continue;
    }
    const resolved = resolveImport(file, specifier);
    if (
      file.startsWith("apps/web/src/") &&
      (resolved === "@capstone/api" ||
        resolved.startsWith("@capstone/api/") ||
        resolved.includes("apps/api/"))
    ) {
      record(file, `imports API internals through ${specifier}`);
    }
    if (
      file.startsWith("packages/protocol/") &&
      (resolved.startsWith("@capstone/api") ||
        resolved.startsWith("@capstone/web") ||
        resolved.includes("apps/"))
    ) {
      record(file, `imports an application through ${specifier}`);
    }
  }
}

for (const file of files.filter((candidate) => candidate.endsWith("package.json"))) {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, file), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  for (const forbidden of forbiddenDependencies) {
    if (dependencies[forbidden] !== undefined) {
      record(file, `contains prohibited dependency ${forbidden}`);
    }
  }
  if (file === "apps/web/package.json" && dependencies["@capstone/api"] !== undefined) {
    record(file, "declares the API application as a dependency");
  }
  if (file === "packages/protocol/package.json") {
    for (const dependency of Object.keys(dependencies)) {
      if (dependency === "@capstone/api" || dependency === "@capstone/web") {
        record(file, `declares application dependency ${dependency}`);
      }
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Repository boundary and credential scan passed for ${files.length} files.\n`);
