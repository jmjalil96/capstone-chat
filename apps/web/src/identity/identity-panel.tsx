import { type ReactNode, useLayoutEffect, useRef } from "react";

import { copy } from "../copy";

export function IdentityPanel({
  children,
  description,
  eyebrow,
  title,
  documentTitle = title,
  wide = false,
}: {
  children: ReactNode;
  description: string;
  documentTitle?: string;
  eyebrow: string;
  title: string;
  wide?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    document.title = copy.brand.pageTitle(documentTitle);
    if (title.length > 0) {
      titleRef.current?.focus();
    }
  }, [documentTitle, title]);

  return (
    <section className="identity-panel" data-wide={wide || undefined} aria-labelledby="page-title">
      <p className="identity-eyebrow">{eyebrow}</p>
      <h1 id="page-title" ref={titleRef} tabIndex={-1}>
        {title}
      </h1>
      <p className="identity-description">{description}</p>
      {children}
    </section>
  );
}
