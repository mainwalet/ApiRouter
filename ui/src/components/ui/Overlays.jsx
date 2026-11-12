import { useEffect, useRef } from "react";
import { Icon } from "./Icon.jsx";
import { usePageActive } from "../../context/PageActivityContext.js";

/**
 * Background scroll lock shared by every open overlay.
 *
 * Each overlay used to save `body.style.overflow` and put that value back on close.
 * With two overlays open (a confirm dialog over a drawer) the second one saved
 * "hidden", so when they closed in the "wrong" order the page was left locked for
 * good. A counter fixes that: the first lock remembers the original value, the
 * last unlock restores it, whatever order they close in.
 */
let scrollLocks = 0;
let scrollLockOriginal = "";

function lockBodyScroll() {
  if (scrollLocks === 0) {
    scrollLockOriginal = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  scrollLocks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    scrollLocks = Math.max(0, scrollLocks - 1);
    if (scrollLocks === 0) document.body.style.overflow = scrollLockOriginal;
  };
}

/**
 * Focus management shared by the modal and the drawer.
 *
 * Three things are handled here because getting them wrong makes an overlay
 * unusable with a keyboard:
 *   - focus moves into the overlay on open, and returns to the trigger on close
 *   - Tab is trapped inside, so focus cannot wander onto the page behind
 *   - Escape closes, and background scroll is locked
 *
 * An overlay on a page the operator has moved away from (the page stays mounted,
 * hidden) lets go of all of that, so it cannot trap keys or lock scrolling on the
 * page that is on screen; it takes hold again when its page is shown.
 */
export function useOverlay({ open, onClose, initialFocusRef = null }) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);
  const pageActive = usePageActive();

  // Keep the latest onClose in a ref. Parents usually pass a fresh function on
  // every render (e.g. each auto-refresh); if it were an effect dependency the
  // effect would re-run, steal focus from whatever the person is typing in and
  // dismiss the phone keyboard.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || !pageActive) return undefined;

    previouslyFocused.current = document.activeElement;

    const container = containerRef.current;
    const focusTarget =
      initialFocusRef?.current ??
      container?.querySelector("[data-autofocus]") ??
      container?.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");

    focusTarget?.focus?.();

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current?.();
        return;
      }

      if (event.key !== "Tab" || !container) return;

      const focusable = [...container.querySelectorAll(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )].filter((element) => element.offsetParent !== null);

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable.at(-1);

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);

    const unlockBodyScroll = lockBodyScroll();

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      unlockBodyScroll();
      previouslyFocused.current?.focus?.();
    };
  }, [open, pageActive, initialFocusRef]);

  return containerRef;
}

export function Drawer({ open, onClose, title, subtitle = null, children, footer = null, wide = false, actions = null }) {
  const containerRef = useOverlay({ open, onClose });

  if (!open) return null;

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close panel" tabIndex={-1} />
      <aside
        ref={containerRef}
        className={`drawer${wide ? " drawer--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : "Details"}
      >
        <header className="overlay-head">
          <div className="grow">
            <div className="overlay-title truncate">{title}</div>
            {subtitle ? <div className="overlay-subtitle truncate">{subtitle}</div> : null}
          </div>
          <div className="overlay-head__actions">
            {actions}
            <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </aside>
    </>
  );
}

export function Modal({ open, onClose, title, children, footer = null, labelledBy = "modal-title" }) {
  const containerRef = useOverlay({ open, onClose });

  if (!open) return null;

  return (
    <>
      <button type="button" className="scrim" onClick={onClose} aria-label="Close dialog" tabIndex={-1} />
      <div ref={containerRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        <header className="overlay-head">
          <div className="overlay-title" id={labelledBy}>{title}</div>
          <div className="overlay-head__actions">
            <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </div>
    </>
  );
}
