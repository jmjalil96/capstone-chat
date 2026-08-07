import { type RefObject, useLayoutEffect } from "react";

import { copy } from "../copy";

export function useRouteHeading(
  title: string,
  headingRef: RefObject<HTMLElement | null>,
  focus = true,
): void {
  useLayoutEffect(() => {
    document.title = copy.brand.pageTitle(title);
    if (focus) {
      headingRef.current?.focus();
    }
  }, [focus, headingRef, title]);
}
