export async function loadEntrypoint(
  loadEnvironment: () => void,
  importTarget: () => Promise<unknown>,
): Promise<void> {
  loadEnvironment();
  await importTarget();
}
