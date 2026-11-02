/** Accept only the app's own approval route and the signed request parameter. */
export function safeApprovalHref(
  value: unknown,
  appOrigin: string,
): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value, appOrigin);
    const origin = new URL(appOrigin).origin;
    if (
      url.origin !== origin ||
      url.pathname !== "/approve" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.searchParams.get("r")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

const APPROVAL_LINK_MARKER = "\uE000approval-link\uE001";
const APPROVAL_MARKDOWN_LINK =
  /\[[^\]]*\]\(\s*https?:\/\/[^\s)]*\/approve\?r=[^\s)]*\s*\)/gi;
const APPROVAL_URL = /https?:\/\/[^\s<>"'`)]*\/approve\?r=[^\s<>"'`)\]]+/gi;
const APPROVAL_GUIDANCE =
  "Use the “Review this refund” button above to open the passkey approval";

/** Hide signed links only in assistant text; the server-provided CTA remains authoritative. */
export function assistantReplyForDisplay(text: string): string {
  let found = false;
  let display = text.replace(APPROVAL_MARKDOWN_LINK, () => {
    found = true;
    return APPROVAL_LINK_MARKER;
  });
  display = display.replace(APPROVAL_URL, (match) => {
    found = true;
    const punctuation = match.match(/[.,!?;:]+$/)?.[0] ?? "";
    return `${APPROVAL_LINK_MARKER}${punctuation}`;
  });
  if (!found) return text;

  display = display
    .replaceAll(`<${APPROVAL_LINK_MARKER}>`, APPROVAL_LINK_MARKER)
    .replace(
      new RegExp(`\\[[^\\]]*\\]\\(\\s*${APPROVAL_LINK_MARKER}\\s*\\)`, "g"),
      APPROVAL_LINK_MARKER,
    )
    .replace(APPROVAL_LINK_MARKER, APPROVAL_GUIDANCE)
    .replaceAll(APPROVAL_LINK_MARKER, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;!?])/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!/[.!?]["')\]]?$/.test(display)) display += ".";
  return display;
}
