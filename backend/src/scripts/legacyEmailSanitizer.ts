/**
 * The Customer Emails sanitizer exactly as it ran from 12 Aug 2026 (commit 127b50d) until the
 * fidelity fix. Frozen here, not imported, because the live one has since changed.
 *
 * refreshInboundEmailBodies.ts uses it as its gate: a stored body is rewritten only when this
 * rule, run again on the message's own source, gives back exactly what is stored — proof
 * that the row is what the old code made of that message and nothing else touched it.
 * Do not edit it; a changed copy would wave through rows it should refuse.
 */

/** Elements that either execute, navigate, or reach out to another host. */
const FORBIDDEN_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "svg",
];

/** `javascript:`, `vbscript:` and `data:` URLs in a href/src position. */
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data|file)\s*:/i;

function stripElement(html: string, tag: string): string {
  // Paired form first, then any stray self-closing or unclosed opener.
  return html
    .replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
}

/**
 * Remove `on*="..."` handlers. Written as a tag-level pass rather than a global one so a
 * body that merely mentions `onclick=` in its text is not corrupted.
 */
function stripEventHandlers(tag: string): string {
  return tag.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** Neutralise a href/src that would execute rather than fetch. Leaves `cid:` alone. */
function stripDangerousUrls(tag: string): string {
  return tag.replace(
    /\s(href|src|xlink:href|action|formaction)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (whole, attribute: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      return DANGEROUS_URL.test(value) ? "" : whole;
    },
  );
}

/** Drop `expression()` and `@import`, the two CSS routes back to script and to the network. */
function stripDangerousCss(tag: string): string {
  return tag.replace(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (whole, dq?: string, sq?: string) => {
    const value = dq ?? sq ?? "";
    return /expression\s*\(|@import|javascript\s*:/i.test(value) ? "" : whole;
  });
}

export function legacySanitizeEmailHtml(html: string): string {
  let out = String(html ?? "");
  if (!out.trim()) return "";

  // Comments can hide a closing tag and reopen parsing somewhere unexpected.
  out = out.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of FORBIDDEN_ELEMENTS) out = stripElement(out, tag);
  // <style> blocks are kept — they are how mail does layout — but only after the URL and
  // expression routes above have been taken out of the document.
  out = out.replace(/@import[^;]*;?/gi, "");
  out = out.replace(/expression\s*\([^)]*\)/gi, "");

  // Now walk the surviving tags and clean their attributes.
  out = out.replace(/<[a-z][^>]*>/gi, (tag) =>
    stripDangerousCss(stripDangerousUrls(stripEventHandlers(tag))),
  );

  return out;
}
