// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Overflow containers must be keyboard-scrollable.
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Component, createContext, memo, type ReactNode, useContext, useMemo } from "react";
import ReactMarkdown, {
  type Components,
  type Options as ReactMarkdownOptions,
  type UrlTransform,
} from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import styles from "./message-content.module.css";

const APPROVED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

const LANGUAGE_ALIASES = new Map<string, string>([
  ["bash", "bash"],
  ["cjs", "javascript"],
  ["css", "css"],
  ["cts", "typescript"],
  ["html", "xml"],
  ["javascript", "javascript"],
  ["js", "javascript"],
  ["json", "json"],
  ["jsx", "javascript"],
  ["markdown", "markdown"],
  ["md", "markdown"],
  ["mjs", "javascript"],
  ["mts", "typescript"],
  ["py", "python"],
  ["python", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["sql", "sql"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["typescript", "typescript"],
  ["xml", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["zsh", "bash"],
]);

const HIGHLIGHT_LANGUAGES: Readonly<Record<string, LanguageFn>> = {
  bash,
  css,
  javascript,
  json,
  markdown,
  python,
  sql,
  typescript,
  xml,
  yaml,
};

interface RendererNode {
  readonly type?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly children?: readonly unknown[];
  properties?: Record<string, unknown>;
}

function rendererNode(value: unknown): RendererNode | undefined {
  return typeof value === "object" && value !== null ? (value as RendererNode) : undefined;
}

function visitRendererTree(
  value: unknown,
  visitor: (node: RendererNode, parent: RendererNode | undefined) => void,
  parent?: RendererNode,
): void {
  const node = rendererNode(value);
  if (!node) {
    return;
  }

  visitor(node, parent);
  for (const child of node.children ?? []) {
    visitRendererTree(child, visitor, node);
  }
}

function classNames(node: RendererNode): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : [];
}

function filterCodeLanguages() {
  return (tree: unknown): undefined => {
    visitRendererTree(tree, (node, parent) => {
      if (node.tagName !== "code" || parent?.tagName !== "pre") {
        return;
      }

      const classes = classNames(node);
      const languageClass = classes.find(
        (name) => name.startsWith("language-") || name.startsWith("lang-"),
      );
      if (!languageClass) {
        return;
      }

      const separator = languageClass.indexOf("-");
      const label = languageClass.slice(separator + 1).toLowerCase();
      const language = LANGUAGE_ALIASES.get(label);
      const retained = classes.filter(
        (name) =>
          !name.startsWith("language-") &&
          !name.startsWith("lang-") &&
          name !== "no-highlight" &&
          name !== "nohighlight",
      );

      node.properties ??= {};
      node.properties.className = language
        ? [...retained, `language-${language}`]
        : [...retained, "no-highlight"];
    });
  };
}

function containsDisplayMath(node: RendererNode): boolean {
  if (node.tagName === "math" && node.properties?.display === "block") {
    return true;
  }

  return (node.children ?? []).some((child) => {
    const childNode = rendererNode(child);
    return childNode ? containsDisplayMath(childNode) : false;
  });
}

function prepareMathOutput() {
  return (tree: unknown): undefined => {
    visitRendererTree(tree, (node) => {
      const classes = classNames(node);
      if (classes.includes("katex-error") && node.properties) {
        delete node.properties.style;
        delete node.properties.title;
      }
      if (!classes.includes("katex")) {
        return;
      }

      const display = containsDisplayMath(node);
      node.properties ??= {};
      node.properties.className = [
        ...classes,
        display ? "capstone-math-display" : "capstone-math-inline",
      ];
      node.properties["data-message-overflow"] = "math";
    });
  };
}

function isSafeDestination(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    return APPROVED_PROTOCOLS.has(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}

const safeUrlTransform: UrlTransform = (url, key) =>
  key === "href" && isSafeDestination(url) ? url : "";

function rendererText(value: unknown): string {
  const node = rendererNode(value);
  if (!node) {
    return "";
  }
  if (node.type === "text") {
    return node.value ?? "";
  }

  return (node.children ?? []).map(rendererText).join("");
}

function fencedCodeSource(node: unknown): string {
  const value = rendererText(node);
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function fencedCodeNode(node: unknown): RendererNode | undefined {
  return rendererNode(node)
    ?.children?.map(rendererNode)
    .find((child) => child?.tagName === "code");
}

interface RendererContextValue {
  readonly overflowLabel: string | undefined;
  readonly renderCodeAction: ((source: string) => ReactNode) | undefined;
}

const RendererContext = createContext<RendererContextValue>({
  overflowLabel: undefined,
  renderCodeAction: undefined,
});

const markdownComponents: Components = {
  a: ({ children, href }) =>
    isSafeDestination(href) ? (
      <a className={styles.link} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span className={styles.invalidLink}>{children}</span>
    ),
  h1: ({ children }) => <h2 className={styles.headingOne}>{children}</h2>,
  h2: ({ children }) => <h3 className={styles.headingTwo}>{children}</h3>,
  h3: ({ children }) => <h4 className={styles.headingThree}>{children}</h4>,
  h4: ({ children }) => <h5 className={styles.headingFour}>{children}</h5>,
  h5: ({ children }) => <h6 className={styles.headingFive}>{children}</h6>,
  h6: ({ children }) => <h6 className={styles.headingSix}>{children}</h6>,
  img: ({ alt }) => (alt ? <span className={styles.suppressedMedia}>{alt}</span> : null),
  input: ({ checked }) => (
    <input checked={Boolean(checked)} disabled readOnly tabIndex={-1} type="checkbox" />
  ),
  pre: ({ children, node }) => {
    const { overflowLabel, renderCodeAction } = useContext(RendererContext);
    const codeNode = fencedCodeNode(node);
    if (!codeNode) {
      return children;
    }
    const source = fencedCodeSource(codeNode);
    const accessibility = overflowLabel
      ? ({ "aria-label": overflowLabel, role: "region" } as const)
      : {};

    return (
      <div className={styles.codeBlock} data-message-overflow="code">
        {renderCodeAction ? (
          <div className={styles.codeAction}>{renderCodeAction(source)}</div>
        ) : null}
        <div {...accessibility} className={styles.codeScroll} tabIndex={0}>
          <pre>{children}</pre>
        </div>
      </div>
    );
  },
  span: ({ children, className, node: _node, ...properties }) => {
    const { overflowLabel } = useContext(RendererContext);
    if (!className?.includes("capstone-math-display")) {
      return (
        <span {...properties} className={className}>
          {children}
        </span>
      );
    }
    const accessibility = overflowLabel
      ? ({ "aria-label": overflowLabel, role: "region" } as const)
      : {};

    return (
      <span {...properties} {...accessibility} className={className} tabIndex={0}>
        {children}
      </span>
    );
  },
  table: ({ children }) => {
    const { overflowLabel } = useContext(RendererContext);
    const accessibility = overflowLabel
      ? ({ "aria-label": overflowLabel, role: "region" } as const)
      : {};

    return (
      <div
        {...accessibility}
        className={styles.tableScroll}
        data-message-overflow="table"
        tabIndex={0}
      >
        <table>{children}</table>
      </div>
    );
  },
};

const remarkPlugins: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [remarkGfm, remarkMath];

const rehypePlugins: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  filterCodeLanguages,
  [rehypeHighlight, { detect: false, languages: HIGHLIGHT_LANGUAGES }],
  [
    rehypeKatex,
    {
      maxExpand: 1_000,
      maxSize: 20,
      output: "mathml",
      strict: "ignore",
      trust: false,
    },
  ],
  prepareMathOutput,
];

interface RendererBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  readonly source: string;
}

interface RendererBoundaryState {
  readonly failed: boolean;
  readonly source: string;
}

class RendererBoundary extends Component<RendererBoundaryProps, RendererBoundaryState> {
  override state: RendererBoundaryState = {
    failed: false,
    source: this.props.source,
  };

  static getDerivedStateFromError(): Partial<RendererBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: RendererBoundaryProps,
    state: RendererBoundaryState,
  ): Partial<RendererBoundaryState> | null {
    return props.source === state.source ? null : { failed: false, source: props.source };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className={`${styles.root} ${styles.error}`} role="alert">
          {this.props.fallback}
        </div>
      );
    }

    return this.props.children;
  }
}

export interface MessageContentProps {
  readonly fallback: ReactNode;
  readonly overflowLabel?: string;
  readonly renderCodeAction?: (source: string) => ReactNode;
  readonly source: string;
}

export const MessageContent = memo(function MessageContent({
  fallback,
  overflowLabel,
  renderCodeAction,
  source,
}: MessageContentProps) {
  const rendererContext = useMemo<RendererContextValue>(
    () => ({ overflowLabel, renderCodeAction }),
    [overflowLabel, renderCodeAction],
  );

  return (
    <RendererContext.Provider value={rendererContext}>
      <RendererBoundary fallback={fallback} source={source}>
        <div className={`message-content ${styles.root}`} data-message-content="">
          <ReactMarkdown
            components={markdownComponents}
            rehypePlugins={rehypePlugins}
            remarkPlugins={remarkPlugins}
            skipHtml
            urlTransform={safeUrlTransform}
          >
            {source}
          </ReactMarkdown>
        </div>
      </RendererBoundary>
    </RendererContext.Provider>
  );
});
