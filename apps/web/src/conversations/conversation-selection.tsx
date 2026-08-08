import { Component, type RefObject } from "react";

function selectionIsInside(container: HTMLElement, selection: Selection): boolean {
  return Boolean(
    !selection.isCollapsed &&
      ((selection.anchorNode && container.contains(selection.anchorNode)) ||
        (selection.focusNode && container.contains(selection.focusNode))),
  );
}

interface InsideSelectionEndpoint {
  readonly affinity: "backward" | "forward";
  readonly kind: "inside";
  readonly root: SelectionRoot;
  readonly textOffset: number;
}

interface OutsideSelectionEndpoint {
  readonly kind: "outside";
  readonly node: Node;
  readonly offset: number;
}

type SelectionEndpoint = InsideSelectionEndpoint | OutsideSelectionEndpoint;

type SelectionRoot =
  | { readonly kind: "container" }
  | {
      readonly index: number;
      readonly kind: "message-selection-root";
      readonly messageId: string;
    }
  | { readonly kind: "message" | "message-content"; readonly messageId: string };

export interface ConversationSelectionSnapshot {
  readonly anchor: SelectionEndpoint;
  readonly focus: SelectionEndpoint;
}

interface SelectionEndpointContext {
  readonly after: string;
  readonly before: string;
}

interface TransientSelectionSnapshot {
  readonly anchorContext: SelectionEndpointContext | undefined;
  readonly focusContext: SelectionEndpointContext | undefined;
  readonly position: ConversationSelectionSnapshot;
}

const SELECTION_CONTEXT_LENGTH = 48;
const SELECTION_EXCLUDED_SELECTOR = "[data-message-selection-excluded]";

interface IndexedSelectionText {
  readonly nodes: readonly { readonly node: Text; readonly start: number }[];
  readonly startByNode: ReadonlyMap<Text, number>;
  readonly text: string;
}

interface SelectionPhaseCache {
  readonly indexes: Map<HTMLElement, IndexedSelectionText>;
  readonly rootIdentityByElement: Map<HTMLElement, SelectionRoot>;
  readonly roots: Map<string, HTMLElement | undefined>;
}

function selectionPhaseCache(): SelectionPhaseCache {
  return {
    indexes: new Map(),
    rootIdentityByElement: new Map(),
    roots: new Map(),
  };
}

function selectionRootKey(root: SelectionRoot): string {
  return root.kind === "container"
    ? root.kind
    : root.kind === "message-selection-root"
      ? `${root.kind}:${root.messageId}:${root.index}`
      : `${root.kind}:${root.messageId}`;
}

function cacheRoot(cache: SelectionPhaseCache, root: SelectionRoot, element: HTMLElement): void {
  cache.rootIdentityByElement.set(element, root);
  cache.roots.set(selectionRootKey(root), element);
}

function selectionTextIndex(root: HTMLElement): IndexedSelectionText {
  const nodes: { readonly node: Text; readonly start: number }[] = [];
  const parts: string[] = [];
  const startByNode = new Map<Text, number>();
  let start = 0;
  const pending = [...root.childNodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).matches(SELECTION_EXCLUDED_SELECTOR)
    ) {
      continue;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      nodes.push({ node: text, start });
      startByNode.set(text, start);
      parts.push(text.data);
      start += text.data.length;
      continue;
    }
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index];
      if (child) {
        pending.push(child);
      }
    }
  }
  return { nodes, startByNode, text: parts.join("") };
}

function selectionTextIndexForRoot(
  root: HTMLElement,
  cache: Map<HTMLElement, IndexedSelectionText>,
): IndexedSelectionText {
  const cached = cache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  const index = selectionTextIndex(root);
  cache.set(root, index);
  return index;
}

function selectableTextLength(node: Node): number {
  if (
    node.nodeType === Node.ELEMENT_NODE &&
    (node as Element).matches(SELECTION_EXCLUDED_SELECTOR)
  ) {
    return 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return (node as Text).data.length;
  }
  let length = 0;
  for (const child of node.childNodes) {
    length += selectableTextLength(child);
  }
  return length;
}

function textOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
  index: IndexedSelectionText,
): number | undefined {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node as Text;
    const start = index.startByNode.get(text);
    return start !== undefined && offset >= 0 && offset <= text.data.length
      ? start + offset
      : undefined;
  }
  let result: number | undefined;
  let total = 0;
  const visit = (current: Node): boolean => {
    if (
      current !== root &&
      current.nodeType === Node.ELEMENT_NODE &&
      (current as Element).matches(SELECTION_EXCLUDED_SELECTOR)
    ) {
      return false;
    }
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) {
        const length = (current as Text).data.length;
        result = offset >= 0 && offset <= length ? total + offset : undefined;
      } else if (offset >= 0 && offset <= current.childNodes.length) {
        for (let index = 0; index < offset; index += 1) {
          const child = current.childNodes[index];
          total += child ? selectableTextLength(child) : 0;
        }
        result = total;
      }
      return true;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      total += (current as Text).data.length;
      return false;
    }
    for (const child of current.childNodes) {
      if (visit(child)) {
        return true;
      }
    }
    return false;
  };
  try {
    visit(root);
  } catch {
    // A selection can become stale while a route is being replaced.
  }
  return result;
}

function endpointRoot(
  container: HTMLElement,
  node: Node,
  cache: SelectionPhaseCache,
): {
  readonly element: HTMLElement;
  readonly identity: SelectionRoot;
} {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node.parentElement ?? undefined);
  const message = element?.closest<HTMLElement>("[data-message-id]");
  const messageId = message?.dataset.messageId;
  if (message && messageId && container.contains(message)) {
    const stableRoot = element?.closest<HTMLElement>("[data-message-selection-root]");
    if (stableRoot && message.contains(stableRoot)) {
      const cached = cache.rootIdentityByElement.get(stableRoot);
      if (cached) {
        return { element: stableRoot, identity: cached };
      }
      const roots = [...message.querySelectorAll<HTMLElement>("[data-message-selection-root]")];
      for (const [index, candidate] of roots.entries()) {
        cacheRoot(cache, { index, kind: "message-selection-root", messageId }, candidate);
      }
      const index = roots.indexOf(stableRoot);
      if (index >= 0) {
        const identity = { index, kind: "message-selection-root", messageId } as const;
        return {
          element: stableRoot,
          identity,
        };
      }
    }
    const content = element?.closest<HTMLElement>("[data-message-content]");
    if (content && message.contains(content)) {
      const identity = { kind: "message-content", messageId } as const;
      cacheRoot(cache, identity, content);
      return {
        element: content,
        identity,
      };
    }
    const identity = { kind: "message", messageId } as const;
    cacheRoot(cache, identity, message);
    return { element: message, identity };
  }
  const identity = { kind: "container" } as const;
  cacheRoot(cache, identity, container);
  return { element: container, identity };
}

function selectionEndpoint(
  container: HTMLElement,
  node: Node,
  offset: number,
  cache: SelectionPhaseCache,
): SelectionEndpoint | undefined {
  if (!container.contains(node)) {
    return { kind: "outside", node, offset };
  }
  const root = endpointRoot(container, node, cache);
  const absoluteOffset = textOffset(
    root.element,
    node,
    offset,
    selectionTextIndexForRoot(root.element, cache.indexes),
  );
  return absoluteOffset === undefined
    ? undefined
    : {
        affinity: node.nodeType === Node.TEXT_NODE && offset === 0 ? "forward" : "backward",
        kind: "inside",
        root: root.identity,
        textOffset: absoluteOffset,
      };
}

export function captureConversationSelection(
  container: HTMLElement,
  cache = selectionPhaseCache(),
): ConversationSelectionSnapshot | undefined {
  const selection = container.ownerDocument.getSelection();
  if (
    !selection ||
    !selectionIsInside(container, selection) ||
    !selection.anchorNode ||
    !selection.focusNode
  ) {
    return undefined;
  }
  const anchor = selectionEndpoint(container, selection.anchorNode, selection.anchorOffset, cache);
  const focus = selectionEndpoint(container, selection.focusNode, selection.focusOffset, cache);
  return anchor && focus ? { anchor, focus } : undefined;
}

function selectionEndpointsEqual(left: SelectionEndpoint, right: SelectionEndpoint): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === "inside" && right.kind === "inside"
    ? left.textOffset === right.textOffset &&
        left.affinity === right.affinity &&
        left.root.kind === right.root.kind &&
        (left.root.kind === "container" ||
          (right.root.kind !== "container" &&
            left.root.messageId === right.root.messageId &&
            (left.root.kind !== "message-selection-root" ||
              (right.root.kind === "message-selection-root" &&
                left.root.index === right.root.index))))
    : left.kind === "outside" &&
        right.kind === "outside" &&
        left.node === right.node &&
        left.offset === right.offset;
}

export function conversationSelectionSnapshotsEqual(
  left: ConversationSelectionSnapshot | undefined,
  right: ConversationSelectionSnapshot | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      selectionEndpointsEqual(left.anchor, right.anchor) &&
      selectionEndpointsEqual(left.focus, right.focus),
  );
}

function resolveSelectionRoot(
  container: HTMLElement,
  root: SelectionRoot,
  cache: SelectionPhaseCache,
): HTMLElement | undefined {
  const key = selectionRootKey(root);
  if (cache.roots.has(key)) {
    return cache.roots.get(key);
  }
  if (root.kind === "container") {
    cacheRoot(cache, root, container);
    return container;
  }
  const message = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (candidate) => candidate.dataset.messageId === root.messageId,
  );
  const resolved =
    root.kind === "message-selection-root"
      ? message?.querySelectorAll<HTMLElement>("[data-message-selection-root]")[root.index]
      : root.kind === "message-content"
        ? (message?.querySelector<HTMLElement>("[data-message-content]") ?? undefined)
        : message;
  cache.roots.set(key, resolved);
  if (resolved) {
    cache.rootIdentityByElement.set(resolved, root);
  }
  return resolved;
}

function endpointContext(
  container: HTMLElement,
  endpoint: SelectionEndpoint,
  cache: SelectionPhaseCache,
): SelectionEndpointContext | undefined {
  if (endpoint.kind !== "inside") {
    return undefined;
  }
  const root = resolveSelectionRoot(container, endpoint.root, cache);
  if (!root) {
    return undefined;
  }
  const text = selectionTextIndexForRoot(root, cache.indexes).text;
  return {
    after: text.slice(endpoint.textOffset, endpoint.textOffset + SELECTION_CONTEXT_LENGTH),
    before: text.slice(
      Math.max(0, endpoint.textOffset - SELECTION_CONTEXT_LENGTH),
      endpoint.textOffset,
    ),
  };
}

function captureTransientSelection(container: HTMLElement): TransientSelectionSnapshot | undefined {
  const cache = selectionPhaseCache();
  const position = captureConversationSelection(container, cache);
  return position
    ? {
        anchorContext: endpointContext(container, position.anchor, cache),
        focusContext: endpointContext(container, position.focus, cache),
        position,
      }
    : undefined;
}

function matchingPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[length] === right[length]) {
    length += 1;
  }
  return length;
}

function matchingSuffix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let length = 0;
  while (length < limit && left[left.length - length - 1] === right[right.length - length - 1]) {
    length += 1;
  }
  return length;
}

function addContextCandidates(
  candidates: Set<number>,
  text: string,
  context: string,
  side: "after" | "before",
): void {
  const lengths = new Set(
    [context.length, 32, 16, 8, 4, 2].filter((length) => length > 0 && length <= context.length),
  );
  for (const length of lengths) {
    const fragment = side === "before" ? context.slice(-length) : context.slice(0, length);
    let from = 0;
    let matches = 0;
    while (matches < 128) {
      const index = text.indexOf(fragment, from);
      if (index < 0) {
        break;
      }
      candidates.add(side === "before" ? index + fragment.length : index);
      from = index + 1;
      matches += 1;
    }
  }
}

function relocateTextOffset(
  text: string,
  originalOffset: number,
  context: SelectionEndpointContext | undefined,
  originalAffinity: InsideSelectionEndpoint["affinity"],
): { readonly affinity: InsideSelectionEndpoint["affinity"]; readonly offset: number } {
  const fallback = Math.min(originalOffset, text.length);
  if (!context) {
    return { affinity: originalAffinity, offset: fallback };
  }
  const scoreAt = (candidate: number) => {
    const beforeScore = matchingSuffix(
      context.before,
      text.slice(Math.max(0, candidate - context.before.length), candidate),
    );
    const afterScore = matchingPrefix(
      context.after,
      text.slice(candidate, candidate + context.after.length),
    );
    return { afterScore, beforeScore, score: beforeScore + afterScore };
  };
  const fallbackScores = scoreAt(fallback);
  if (fallbackScores.score === context.before.length + context.after.length) {
    return { affinity: originalAffinity, offset: fallback };
  }
  const candidates = new Set<number>([fallback, 0, text.length]);
  addContextCandidates(candidates, text, context.before, "before");
  addContextCandidates(candidates, text, context.after, "after");

  let best = fallback;
  let bestAfterScore = 0;
  let bestBeforeScore = 0;
  let bestScore = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate < 0 || candidate > text.length) {
      continue;
    }
    const { afterScore, beforeScore, score } = scoreAt(candidate);
    const distance = Math.abs(candidate - originalOffset);
    if (score > bestScore || (score === bestScore && distance < bestDistance)) {
      best = candidate;
      bestAfterScore = afterScore;
      bestBeforeScore = beforeScore;
      bestScore = score;
      bestDistance = distance;
    }
  }
  if (bestScore <= 0) {
    return { affinity: originalAffinity, offset: fallback };
  }
  return {
    affinity:
      best === originalOffset || bestAfterScore === bestBeforeScore
        ? originalAffinity
        : bestAfterScore > bestBeforeScore
          ? "forward"
          : "backward",
    offset: best,
  };
}

function resolveInsideEndpoint(
  container: HTMLElement,
  endpoint: InsideSelectionEndpoint,
  context: SelectionEndpointContext | undefined,
  cache: SelectionPhaseCache,
): ResolvedSelectionEndpoint | undefined {
  const root = resolveSelectionRoot(container, endpoint.root, cache);
  if (!root) {
    return undefined;
  }
  const index = selectionTextIndexForRoot(root, cache.indexes);
  const relocated = relocateTextOffset(index.text, endpoint.textOffset, context, endpoint.affinity);
  for (const indexed of index.nodes) {
    const remaining = relocated.offset - indexed.start;
    const text = indexed.node;
    if (
      remaining >= 0 &&
      (remaining < text.data.length ||
        (remaining === text.data.length && relocated.affinity === "backward"))
    ) {
      return {
        node: text,
        offset: remaining,
        position: {
          affinity: relocated.affinity,
          kind: "inside",
          root: endpoint.root,
          textOffset: relocated.offset,
        },
      };
    }
  }
  const last = index.nodes.at(-1)?.node;
  return relocated.offset === index.text.length && last
    ? {
        node: last,
        offset: last.data.length,
        position: {
          affinity: relocated.affinity,
          kind: "inside",
          root: endpoint.root,
          textOffset: relocated.offset,
        },
      }
    : undefined;
}

interface ResolvedSelectionEndpoint {
  readonly node: Node;
  readonly offset: number;
  readonly position: SelectionEndpoint;
}

function resolveSelectionEndpoint(
  container: HTMLElement,
  endpoint: SelectionEndpoint,
  context: SelectionEndpointContext | undefined,
  cache: SelectionPhaseCache,
): ResolvedSelectionEndpoint | undefined {
  if (endpoint.kind === "inside") {
    return resolveInsideEndpoint(container, endpoint, context, cache);
  }
  return endpoint.node.isConnected
    ? { node: endpoint.node, offset: endpoint.offset, position: endpoint }
    : undefined;
}

function restoreSelection(
  container: HTMLElement,
  snapshot: TransientSelectionSnapshot,
): ConversationSelectionSnapshot | undefined {
  const selection = container.ownerDocument.getSelection();
  const cache = selectionPhaseCache();
  const anchor = resolveSelectionEndpoint(
    container,
    snapshot.position.anchor,
    snapshot.anchorContext,
    cache,
  );
  const focus = resolveSelectionEndpoint(
    container,
    snapshot.position.focus,
    snapshot.focusContext,
    cache,
  );
  if (!selection || !anchor || !focus) {
    return undefined;
  }
  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    return { anchor: anchor.position, focus: focus.position };
  } catch {
    // A concurrent route replacement can invalidate an otherwise current DOM snapshot.
    return undefined;
  }
}

interface ConversationSelectionFenceProps {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly onSelectionSnapshot: (
    before: ConversationSelectionSnapshot,
    after: ConversationSelectionSnapshot,
  ) => void;
}

// React's pre-mutation class lifecycle is required here: layout effects run after streamed
// Markdown can replace selected text nodes. React retains lifecycle return values, so content
// context stays in a private field that is cleared immediately after the commit.
export class ConversationSelectionFence extends Component<
  ConversationSelectionFenceProps,
  Record<string, never>,
  boolean | null
> {
  private transientSelection: TransientSelectionSnapshot | undefined;

  override getSnapshotBeforeUpdate(
    _previousProps: Readonly<ConversationSelectionFenceProps>,
  ): boolean | null {
    const container = this.props.containerRef.current;
    this.transientSelection = container ? captureTransientSelection(container) : undefined;
    return this.transientSelection ? true : null;
  }

  override componentDidUpdate(
    _previousProps: Readonly<ConversationSelectionFenceProps>,
    _previousState: Readonly<Record<string, never>>,
    hasSnapshot: boolean | null,
  ): void {
    const container = this.props.containerRef.current;
    const snapshot = this.transientSelection;
    this.transientSelection = undefined;
    if (!container || !hasSnapshot || !snapshot) {
      return;
    }
    const restored = restoreSelection(container, snapshot);
    this.props.onSelectionSnapshot(snapshot.position, restored ?? snapshot.position);
  }

  override componentWillUnmount(): void {
    this.transientSelection = undefined;
  }

  override render(): null {
    return null;
  }
}
