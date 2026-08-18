import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const privacyAttestationPath = fileURLToPath(
  new URL("../.env.openrouter-privacy.json", import.meta.url),
);

function run(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal === null
            ? `${command} exited with code ${code ?? 1}`
            : `${command} exited after ${signal}`,
        ),
      );
    });
  });
}

async function ensurePrivacyAttestation() {
  try {
    await readFile(privacyAttestationPath, "utf8");
    return;
  } catch (error) {
    if (error === null || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "OpenRouter privacy confirmation is required in an interactive terminal before first initialization",
    );
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(
      [
        "",
        "Live OpenRouter development sends real conversation content and can incur charges.",
        "Verify in the OpenRouter workspace that all three settings are disabled:",
        "- Data Discount logging",
        "- Input & Output Logging",
        "- Broadcast",
        "",
      ].join("\n"),
    );
    const answer = await terminal.question('Type "CONFIRM" to record this local attestation: ');
    if (answer !== "CONFIRM") {
      throw new Error("OpenRouter privacy confirmation was not recorded");
    }
  } finally {
    terminal.close();
  }

  await writeFile(
    privacyAttestationPath,
    `${JSON.stringify(
      {
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function runDevelopmentServers(apiEnvironment, webEnvironment) {
  const api = spawn("pnpm", ["--filter", "@capstone/api", "run", "dev"], {
    cwd: repositoryRoot,
    env: apiEnvironment,
    stdio: "inherit",
  });
  const web = spawn("pnpm", ["--filter", "@capstone/web", "run", "dev"], {
    cwd: repositoryRoot,
    env: webEnvironment,
    stdio: "inherit",
  });
  const children = [api, web];
  const stop = (signal) => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    }
  };
  const forwardInterrupt = () => stop("SIGINT");
  const forwardTermination = () => stop("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      for (const child of children) {
        child.once("error", (error) => {
          if (!settled) {
            settled = true;
            stop("SIGTERM");
            reject(error);
          }
        });
        child.once("exit", (code, signal) => {
          if (!settled) {
            settled = true;
            stop("SIGTERM");
            resolve(signal === null ? (code ?? 1) : 0);
          }
        });
      }
    });
  } finally {
    process.removeListener("SIGINT", forwardInterrupt);
    process.removeListener("SIGTERM", forwardTermination);
  }
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("Add OPENROUTER_API_KEY to .env before running pnpm dev");
  }
  await ensurePrivacyAttestation();
  const safeEnvironment = { ...process.env, MODEL_GATEWAY: "openrouter" };
  delete safeEnvironment.OPENROUTER_API_KEY;
  const apiEnvironment = {
    ...safeEnvironment,
    OPENROUTER_API_KEY: apiKey,
  };

  await run("pnpm", ["--filter", "@capstone/protocol", "build"], safeEnvironment);
  await run("docker", ["compose", "up", "-d", "--wait", "postgres"], safeEnvironment);
  await run("pnpm", ["--filter", "@capstone/api", "dev:initialize"], apiEnvironment);
  process.exitCode = await runDevelopmentServers(apiEnvironment, safeEnvironment);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Development startup failed";
  process.stderr.write(`Development startup failed: ${message}\n`);
  process.exitCode = 1;
});
