#!/usr/bin/env node
import { readOperatorDocument, runOperatorConsole } from "./operator-console.mjs";

const operation = process.argv[2];
if (process.argv.length !== 3 || operation === undefined) {
  throw new Error("One approved console operation is required");
}
const document = await readOperatorDocument();
try {
  const evidence = await runOperatorConsole(operation, { document });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  document.fill(0);
}
