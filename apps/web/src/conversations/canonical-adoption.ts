export type CanonicalAdoptionMode = "adopt" | "recover";

type CanonicalAdoptionListener = (conversationId: string, mode: CanonicalAdoptionMode) => void;

const listeners = new Set<CanonicalAdoptionListener>();

export function notifyCanonicalAdoption(conversationId: string, mode: CanonicalAdoptionMode): void {
  for (const listener of listeners) {
    listener(conversationId, mode);
  }
}

export function subscribeCanonicalAdoption(listener: CanonicalAdoptionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
