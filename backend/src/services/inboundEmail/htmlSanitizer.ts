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
  "input",
  "textarea",
  "select",
  "svg",
];

/**
 * Elements whose tags go but whose contents are the mail. Survey and campaign mail wraps its
 * whole body in a <form>, and deleting the element with everything inside it left a blank
 * page; without the tag nothing can be submitted, and a button with no form does nothing.
 */
const UNWRAPPED_ELEMENTS = ["form", "button"];

/** `javascript:`, `vbscript:` and `data:` URLs in a href/src position. */
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data|file)\s*:/i;

/**
 * A picture carried inside the mail itself. As an image it can only be drawn, never run,
 * so in `src` it stays — some mail tools embed their logo this way. SVG is left out: it is
 * a document, not a bitmap.
 */
const INLINE_BITMAP = /^\s*data:image\/(?:png|jpe?g|gif|webp|bmp)[;,]/i;

function stripElement(html: string, tag: string): string {
  // Paired form first, then any stray self-closing or unclosed opener.
  return html
    .replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
}

function unwrapElement(html: string, tag: string): string {
  return html.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
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
      if (attribute.toLowerCase() === "src" && INLINE_BITMAP.test(value)) return whole;
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

/**
 * A stylesheet's own text, with the routes back to script and to the network taken out.
 *
 * `<!--` and `-->` go too. Outlook wraps every stylesheet it writes in them — a habit from
 * browsers that could not read CSS — and CSS ignores them, so they carry nothing. CSS
 * comments go first, so that a word in one ("keeps Outlook behavior: no gaps") is never
 * read as a declaration. A `<` that could begin a tag is escaped, so nothing kept here can
 * ever be read back as one; a media query's "width < 600px" is not a tag and stays.
 */
function cleanStylesheet(css: string): string {
  return css
    .replace(/<!--|-->/g, "")
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
    // The URL is read as a whole first: a font URL like "...wght@400;600&display=swap" has
    // a ';' inside it, and cutting there left the rest in front of the next rule and broke it.
    .replace(/@import\s*(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')[^;{}]*;?/gi, "")
    .replace(/@import\b[^;{}]*;?/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    // Only as a property of its own: "scroll-behavior" is an ordinary property, not this one.
    .replace(/(^|[{;\s])(?:behavior|-moz-binding)\s*:[^;}]*;?/gi, "$1")
    .replace(/url\(\s*(['"]?)\s*(?:javascript|vbscript)\s*:[^)]*\)/gi, "none")
    .replace(/<(?=[a-z/!?])/gi, "\\3c ");
}

/**
 * One pass over the markup in the order a browser reads it: a comment, a stylesheet, or any
 * other tag. A tag's quoted attribute values are read whole, so a `<style>` or `<!--` inside
 * one is not mistaken for the real thing — but, as in a browser, a quote only opens a value
 * right after `=`. A stray quote anywhere else (`<p ">`) ends the match there instead of
 * running on past the `>` and hiding a real stylesheet from the cleaning.
 */
const DOCUMENT_TOKENS =
  /<!--(?:-?>|[\s\S]*?(?:--!?>|$))|<style\b(?:[^'">=]|=\s*(?:"[^"]*"|'[^']*'|[^'"\s>]*))*>[\s\S]*?(?:<\/style\s*>|$)|<[a-z!/?](?:[^'">=]|=\s*(?:"[^"]*"|'[^']*'|[^'"\s>]*))*>/gi;

function cleanTag(tag: string): string {
  return stripDangerousCss(stripDangerousUrls(stripEventHandlers(tag)));
}

export function sanitizeEmailHtml(html: string): string {
  // NUL marks a set-aside stylesheet below, so none may come from the mail itself. A
  // browser drops NUL from text anyway.
  let out = String(html ?? "").replace(/\u0000/g, "");
  if (!out.trim()) return "";

  // Comments can hide a closing tag and reopen parsing somewhere unexpected, so they go —
  // all except the ones inside a stylesheet, which are not comments to a browser at all.
  // Outlook writes every mail's fonts, spacing, colours and table styles as
  // <style><!-- ... --></style>; removing that "comment" removed the whole look of the mail.
  // Stylesheets are cleaned and set aside, so nothing below can reach into their text.
  const stylesheets: string[] = [];
  out = out.replace(DOCUMENT_TOKENS, (token) => {
    if (token.startsWith("<!--")) return "";
    const style = /^(<style\b(?:[^'">=]|=\s*(?:"[^"]*"|'[^']*'|[^'"\s>]*))*>)([\s\S]*?)(<\/style\s*>)?$/i.exec(token);
    if (!style) return token;
    const [, open = "<style>", css = ""] = style;
    stylesheets.push(`${cleanTag(open)}${cleanStylesheet(css)}</style>`);
    return `\u0000${stylesheets.length - 1}\u0000`;
  });

  for (const tag of FORBIDDEN_ELEMENTS) out = stripElement(out, tag);
  for (const tag of UNWRAPPED_ELEMENTS) out = unwrapElement(out, tag);

  // Now walk the surviving tags and clean their attributes.
  out = out.replace(/<[a-z][^>]*>/gi, cleanTag);

  return out.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => stylesheets[Number(index)] ?? "");
}

/**
 * URLs and addresses in a plain-text mail, linked the way Outlook and Gmail link them.
 *
 * Every text-only mail from anyone runs through this during ingest, so it must stay linear:
 * an address may start only where a run of address characters starts (not at each "." or
 * "-" inside one), and every part has a length limit. Without that, a crafted 80 KB mail
 * took 16 seconds and a 1 MB one about 40 minutes, holding up the whole sweep.
 */
const TEXT_LINK =
  /\b(?:https?:\/\/|www\.)(?:[^\s&<>"]|&amp;){1,2048}|(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;

/**
 * A plain-text mail as the reader shows it: every character, space, tab and line exactly as
 * the sender typed them, with web links and addresses clickable.
 *
 * The reader used to show `body_text` instead, which is the copy cleaned for matching and
 * escalation rules. That cleaning cut everything from the first line starting "--" (the
 * whole thread under "-----Original Message-----", a forwarded mail, a signature), removed
 * anything in <...>, decoded "=XX" a second time and squeezed aligned columns together. It
 * stays as it is for those rules; this is the copy for reading.
 */
export function plainTextToHtml(text: string): string {
  const raw = String(text ?? "").replace(/\u0000/g, "");
  if (!raw.trim()) return "";
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const linked = escaped.replace(TEXT_LINK, (match) => {
    // Punctuation that ends the sentence is not part of the link.
    const trail = /(?:[.,;:!?)\]}'*]|&quot;|&gt;)+$/.exec(match)?.[0] ?? "";
    const link = match.slice(0, match.length - trail.length);
    if (!link) return match;
    const href = /^https?:\/\//i.test(link)
      ? link
      : /^www\./i.test(link)
        ? `http://${link}`
        : `mailto:${link}`;
    return `<a href="${href}">${link}</a>${trail}`;
  });
  return `<div style="white-space:pre-wrap;overflow-wrap:break-word">${linked}</div>`;
}

/** What the reader shows: the sender's HTML when the mail has any, otherwise their exact text. */
export function toDisplayHtml(parsed: { html: string; text: string }): string {
  return sanitizeEmailHtml(parsed.html) || plainTextToHtml(parsed.text);
}

/**
 * Point every `cid:` reference at the attachment endpoint so inline pictures load — in an
 * <img src>, a table or body `background`, and a CSS `url(cid:...)`, where stationery and
 * banner backgrounds live.
 *
 * `resolve` returns null for a Content-ID the message does not actually carry. An <img>
 * with such a src loses it rather than render as a broken image. A reference may be
 * URL-encoded (RFC 2392 writes "@" as "%40"), so the decoded form is tried too.
 */
export function resolveInlineImages(
  html: string,
  resolve: (contentId: string) => string | null,
): string {
  const lookup = (value: string): string | null => {
    const contentId = value.trim();
    const found = resolve(contentId);
    if (found) return found;
    try {
      const decoded = decodeURIComponent(contentId);
      return decoded === contentId ? null : resolve(decoded);
    } catch {
      return null;
    }
  };
  return String(html ?? "")
    .replace(
      /(\ssrc\s*=\s*)(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi,
      (_whole, prefix: string, dq?: string, sq?: string, bare?: string) => {
        const url = lookup(dq ?? sq ?? bare ?? "");
        return url ? `${prefix}"${url}"` : "";
      },
    )
    .replace(
      /(\sbackground\s*=\s*)(?:"cid:([^"]+)"|'cid:([^']+)'|cid:([^\s>]+))/gi,
      (whole, prefix: string, dq?: string, sq?: string, bare?: string) => {
        const url = lookup(dq ?? sq ?? bare ?? "");
        return url ? `${prefix}"${url}"` : whole;
      },
    )
    // Unquoted, because this may sit inside a quoted style="..." attribute; the route is
    // made of ids that carry no quotes, spaces or brackets. Inside such an attribute the
    // sender's own quotes arrive as &quot; or &#39;.
    .replace(
      /url\(\s*(&quot;|&#0*39;|["']?)cid:([^"')&]+)\1\s*\)/gi,
      (whole, _quote: string, contentId: string) => {
        const url = lookup(contentId);
        return url ? `url(${url})` : whole;
      },
    );
}
