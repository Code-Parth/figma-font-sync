/**
 * Copies `text` through an off-screen textarea and `execCommand("copy")`. The plugin iframe's permissions
 * policy blocks `navigator.clipboard` unless the manifest asks for an undocumented permission, while
 * execCommand only needs the user activation of the click, so call this synchronously in the click handler.
 * Returns false when the browser refused; the caller then leaves the text for a manual copy.
 */
export function copyText(text: string, doc: Document = document): boolean {
  // Read before the textarea takes focus and selection, so both go back to where the user left them.
  const focused = doc.activeElement as HTMLElement | null;
  const selection = doc.getSelection();
  const ranges =
    selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index));

  const textarea = doc.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  // Off-screen rather than display: none, which cannot be selected.
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  doc.body.append(textarea);

  let copied = false;
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    copied = doc.execCommand("copy");
  } catch {
    // Some engines throw instead of returning false when copying is not allowed; copied stays false.
  } finally {
    textarea.remove();
    focused?.focus({ preventScroll: true });
    if (selection !== null) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  return copied;
}
