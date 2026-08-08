import { describe, expect, it } from "vitest";
import {
  parseOperatorArguments,
  rejectUnknownOperatorArguments,
} from "../src/operator/arguments.js";

describe("operator arguments", () => {
  it("rejects an option outside the command's explicit surface", () => {
    const parsed = parseOperatorArguments(["--model-id", "unapproved/model"]);

    expect(() => rejectUnknownOperatorArguments(parsed, new Set())).toThrow(
      "Argument --model-id is not supported",
    );
  });

  it("accepts only named command options", () => {
    const parsed = parseOperatorArguments(["--mode", "simulated"]);

    expect(() => rejectUnknownOperatorArguments(parsed, new Set(["--mode"]))).not.toThrow();
  });
});
