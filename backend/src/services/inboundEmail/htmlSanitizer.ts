/**
 * Make a mail's HTML safe to put on screen.
 *
 * Mail bodies are attacker-controlled: anyone in the world can send one to a region
 * mailbox, and it lands in a page an admin has open with their session. The reading pane
 * renders inside a sandboxed iframe with scripting switched off, which is the control that
 * actually stops execution — this pass is the second layer, so a mistake in either one
 * alone is not enough.
 *
 * It is a stripper, not a validator: everything dangerous is removed and the rest is left
 * exactly as the sender wrote it, because the whole point of the feature is that the mail
 * looks the way it looked in Outlook. Tables, inline styles, fonts and colours all survive.
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

export function sanitizeEmailHtml(html: string): string {
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

/**
 * Point every `cid:` reference at the attachment endpoint so inline pictures load.
 *
 * `resolve` returns null for a Content-ID the message does not actually carry, in which
 * case the reference is dropped rather than left to render as a broken image.
 */
export function resolveInlineImages(
  html: string,
  resolve: (contentId: string) => string | null,
): string {
  return String(html ?? "").replace(
    /(\ssrc\s*=\s*)(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi,
    (whole, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const contentId = (dq ?? sq ?? bare ?? "").trim();
      const url = resolve(contentId);
      return url ? `${prefix}"${url}"` : "";
    },
  );
}
