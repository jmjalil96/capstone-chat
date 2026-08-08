export function parseOperatorArguments(values: readonly string[]): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>();

  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (
      key === undefined ||
      !key.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("Arguments must use --name value pairs");
    }
    if (parsed.has(key)) {
      throw new Error(`Argument ${key} may be provided only once`);
    }
    parsed.set(key, value);
  }

  return parsed;
}

export function requiredOperatorArgument(
  argumentsMap: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = argumentsMap.get(name)?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function rejectUnknownOperatorArguments(
  argumentsMap: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): void {
  for (const name of argumentsMap.keys()) {
    if (!allowed.has(name)) {
      throw new Error(`Argument ${name} is not supported`);
    }
  }
}
