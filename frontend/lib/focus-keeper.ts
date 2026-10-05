/**
 * The one owner of "a control that was pressed and then busy keeps the focus". A button disabled while its action runs
 * (the design system's isLoading, or isDisabled while the page is busy) loses the keyboard focus to the page's body,
 * and the browser gives nothing back when it is enabled again (WCAG 2.4.3). This gives the focus back to it then,
 * unless the person has moved it somewhere else meanwhile. A control that is replaced rather than enabled again (a notice
 * shown anew) takes the focus itself where that is its job (ProblemAlert's focusRetry).
 */
export function keepFocusThroughBusy(doc: Document): () => void {
  let focused: Element | null = doc.activeElement;
  let lost: HTMLElement | null = null;
  const onFocus = (event: FocusEvent) => {
    focused = event.target as Element;
    lost = null;
  };
  const observer = new MutationObserver((records) => {
    for (const { target } of records) {
      if (!(target instanceof HTMLElement)) continue;
      if (target.matches(":disabled")) {
        if (target === focused) lost = target;
      } else if (target === lost) {
        lost = null;
        const nowhere = doc.activeElement === null || doc.activeElement === doc.body;
        if (nowhere && target.isConnected) target.focus();
      }
    }
  });
  observer.observe(doc.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
  // Focus does not bubble: caught on its way down.
  doc.addEventListener("focus", onFocus, true);
  return () => {
    observer.disconnect();
    doc.removeEventListener("focus", onFocus, true);
  };
}
