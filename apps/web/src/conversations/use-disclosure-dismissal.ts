import { type RefObject, useEffect, useRef } from "react";

interface DisclosureDismissalOptions {
  readonly open: boolean;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly close: (options: { readonly restoreFocus: boolean }) => void;
}

export function useDisclosureDismissal({
  open,
  containerRef,
  triggerRef,
  close,
}: DisclosureDismissalOptions): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) {
      return;
    }
    const container = containerRef.current;
    if (!container) {
      return;
    }

    // WebKit leaves mouse clicks without button focus, so Escape ownership must be
    // established explicitly at open time instead of inferred from the pointer target.
    const trigger = triggerRef.current;
    const activeElement = document.activeElement;
    if (
      trigger?.isConnected &&
      !(activeElement instanceof Node && container.contains(activeElement))
    ) {
      trigger.focus({ preventScroll: true });
    }

    const dismissOutside = (event: PointerEvent) => {
      const pointerTarget = event.target;
      if (pointerTarget instanceof Node && !container.contains(pointerTarget)) {
        closeRef.current({ restoreFocus: false });
        const pointerTrigger = triggerRef.current;
        // The timer must survive this effect's cleanup: closing tears the listeners
        // down before the browser settles focus for the click that dismissed us.
        setTimeout(() => {
          // Restore only when focus was genuinely surrendered: it fell to body, or
          // a tabindex="-1" ancestor absorbed THIS press as the browser's default
          // fallback. Focus moved elsewhere by script (for example an alert the
          // click intentionally focused) is respected, never stolen.
          const settled = document.activeElement;
          const surrendered =
            !settled ||
            settled === document.body ||
            settled === document.documentElement ||
            (settled.getAttribute("tabindex") === "-1" && settled.contains(pointerTarget));
          if (surrendered && pointerTrigger?.isConnected) {
            pointerTrigger.focus({ preventScroll: true });
          }
        }, 0);
      }
    };
    const dismissWithEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !container.contains(event.target)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeRef.current({ restoreFocus: true });
    };
    // WebKit moves focus to the nearest mouse-focusable ANCESTOR (for example a
    // tabindex="-1" region) when a press lands on a button, so a press inside the
    // disclosure can fire a focusin from outside it mid-click. Track in-container
    // presses and hold focus-out dismissal until the press settles, or the click
    // that should activate a row would dismiss the row instead.
    let pointerPressWithin = false;
    const trackPointerWithin = (event: PointerEvent) => {
      if (event.target instanceof Node && container.contains(event.target)) {
        pointerPressWithin = true;
      }
    };
    const releasePointerWithin = () => {
      setTimeout(() => {
        pointerPressWithin = false;
      }, 0);
    };
    const dismissOnFocusOut = (event: FocusEvent) => {
      if (
        !pointerPressWithin &&
        event.target instanceof Node &&
        !container.contains(event.target)
      ) {
        closeRef.current({ restoreFocus: false });
      }
    };
    document.addEventListener("pointerdown", trackPointerWithin);
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("pointerup", releasePointerWithin);
    document.addEventListener("pointercancel", releasePointerWithin);
    document.addEventListener("keydown", dismissWithEscape);
    document.addEventListener("focusin", dismissOnFocusOut);
    return () => {
      document.removeEventListener("pointerdown", trackPointerWithin);
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("pointerup", releasePointerWithin);
      document.removeEventListener("pointercancel", releasePointerWithin);
      document.removeEventListener("keydown", dismissWithEscape);
      document.removeEventListener("focusin", dismissOnFocusOut);
    };
  }, [containerRef, open, triggerRef]);
}
