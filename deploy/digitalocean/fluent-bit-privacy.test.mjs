#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configurationPath = fileURLToPath(new URL("./fluent-bit.conf", import.meta.url));
const configuration = readFileSync(configurationPath, "utf8");
const expectedAllowedFields = [
  "asset",
  "category",
  "clientAddressSource",
  "column",
  "configurationKey",
  "database",
  "databaseColumn",
  "databaseConstraint",
  "databaseRoutine",
  "databaseSchema",
  "databaseSeverity",
  "databaseTable",
  "deploymentRevision",
  "durationMs",
  "emailDelivery",
  "errorCode",
  "errorName",
  "hook",
  "host",
  "hostname",
  "kind",
  "level",
  "line",
  "logLevel",
  "message",
  "method",
  "modelGateway",
  "nodeEnv",
  "operation",
  "pid",
  "port",
  "providerStatus",
  "publicOrigin",
  "purpose",
  "readiness",
  "release",
  "requestId",
  "responseTime",
  "route",
  "signal",
  "statusCode",
  "telemetry",
  "time",
  "trustProxy",
  "webAssets",
].sort();

function fail(message) {
  throw new Error(`Fluent Bit privacy fixture failed: ${message}`);
}

const allowedFields = [...configuration.matchAll(/^\s*Allowlist_key\s+(\S+)\s*$/gmu)]
  .map((match) => match[1])
  .sort();
if (
  allowedFields.length !== expectedAllowedFields.length ||
  allowedFields.some((field, index) => field !== expectedAllowedFields[index])
) {
  fail("the exact operational field allowlist changed");
}
if (!/^\s*Reserve_Data\s+Off\s*$/mu.test(configuration)) {
  fail("the parser retains Docker forwarding metadata");
}
if (
  !/^\s*Hard_Rename\s+msg\s+message\s*$/mu.test(configuration) ||
  !/^\s*Remove\s+log\s*$/mu.test(configuration)
) {
  fail("the raw record or canonical Pino message boundary changed");
}
const maximumMatch = /^\s*Buffer_Max_Size\s+(\d+)K\s*$/mu.exec(configuration);
const maximumBytes = Number(maximumMatch?.[1] ?? "0") * 1_024;
if (maximumBytes !== 16 * 1_024) {
  fail("the exact 16 KiB raw-record input bound changed");
}

const maliciousRecord = {
  authorization: "Bearer secret",
  cookie: "session=secret",
  databaseUrl: "postgresql://secret",
  email: "employee@example.invalid",
  level: 30,
  msg: "request completed",
  prompt: "private prompt",
  providerBody: "private provider payload",
  query: "private search",
  raw: "private raw payload",
  requestId: "00000000-0000-4000-8000-000000000000",
  response: "private response",
  route: "/api/conversations/:conversationId/responses",
  statusCode: 200,
  url: "/api/conversations/search?q=private",
};
const normalized = { ...maliciousRecord, message: maliciousRecord.msg };
delete normalized.msg;
const forwarded = Object.fromEntries(
  Object.entries(normalized).filter(([key]) => allowedFields.includes(key)),
);
for (const forbidden of [
  "authorization",
  "cookie",
  "databaseUrl",
  "email",
  "prompt",
  "providerBody",
  "query",
  "raw",
  "response",
  "url",
]) {
  if (Object.hasOwn(forwarded, forbidden)) {
    fail(`forbidden field ${forbidden} reached the output record`);
  }
}
if (
  forwarded.message !== "request completed" ||
  forwarded.route !== "/api/conversations/:conversationId/responses" ||
  forwarded.statusCode !== 200
) {
  fail("known operational fields were not preserved");
}

const oversizedRawRecord = JSON.stringify({ log: "x".repeat(maximumBytes) });
if (Buffer.byteLength(oversizedRawRecord, "utf8") <= maximumBytes) {
  fail("oversized raw-record fixture did not cross the input limit");
}

process.stdout.write("Fluent Bit privacy fixtures passed.\n");
