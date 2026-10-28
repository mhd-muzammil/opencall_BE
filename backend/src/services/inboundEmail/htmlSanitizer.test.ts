import { describe, expect, it } from "vitest";
import {
  plainTextToHtml,
  resolveInlineImages,
  sanitizeEmailHtml,
  toDisplayHtml,
} from "./htmlSanitizer.js";

// Mail bodies are attacker-controlled — anyone can send one to a region mailbox and it
// lands in a page an admin has open. The sandboxed iframe is what stops execution; this
// pass is the second layer, so it is pinned independently.

describe("sanitizeEmailHtml — what must never survive", () => {
  it("removes a script block and its contents", () => {
    const out = sanitizeEmailHtml("<p>Hi</p><script>fetch('/api/v1/users')</script>");
    expect(out).not.toMatch(/script|fetch/i);
    expect(out).toContain("Hi");
  });

  it("removes inline event handlers", () => {
    const out = sanitizeEmailHtml(`<div onclick="steal()" onmouseover='x()'>Text</div>`);
    expect(out).not.toMatch(/onclick|onmouseover|steal/i);
    expect(out).toContain("Text");
  });

  it("removes javascript: and data: URLs", () => {
    const out = sanitizeEmailHtml(
      `<a href="javascript:alert(1)">a</a><img src="data:text/html,<script>x</script>">`,
    );
    expect(out).not.toMatch(/javascript:|data:text\/html/i);
  });

  it("removes framing, plugin and form elements", () => {
    const out = sanitizeEmailHtml(
      `<iframe src="http://evil"></iframe><object data="x"></object><form action="http://evil"><input name="p"></form><p>Body</p>`,
    );
    expect(out).not.toMatch(/<iframe|<object|<form|<input/i);
    expect(out).toContain("Body");
  });

  it("removes CSS expression() and @import", () => {
    const out = sanitizeEmailHtml(
      `<style>@import url('http://evil/x.css');</style><div style="width:expression(alert(1))">D</div>`,
    );
    expect(out).not.toMatch(/@import|expression\s*\(/i);
    expect(out).toContain("D");
  });

  it("removes comments, which can hide a closing tag", () => {
    expect(sanitizeEmailHtml("<p>A<!-- </p><script>x</script> -->B</p>")).not.toMatch(
      /<!--|script/i,
    );
  });

  it("survives an empty body", () => {
    expect(sanitizeEmailHtml("")).toBe("");
    expect(sanitizeEmailHtml("   ")).toBe("");
  });
});

// The whole point of the feature is that the mail looks like the mail. A sanitiser that
// flattens HP's tables and colours has failed even though nothing dangerous got through.
describe("sanitizeEmailHtml — what must survive", () => {
  it("keeps tables, colours and inline styles", () => {
    const html =
      `<table border="1"><tr><td style="color:#ff0000;font-weight:bold">WO-035104670</td></tr></table>`;
    const out = sanitizeEmailHtml(html);
    expect(out).toContain("<table");
    expect(out).toContain("color:#ff0000");
    expect(out).toContain("WO-035104670");
  });

  it("keeps ordinary links and remote image tags", () => {
    const out = sanitizeEmailHtml(
      `<a href="https://support.hp.com/in-en">HP Support</a><img src="https://hp.com/logo.png">`,
    );
    expect(out).toContain("https://support.hp.com/in-en");
    expect(out).toContain("https://hp.com/logo.png");
  });

  it("keeps a cid: reference for the inline-image pass to rewrite", () => {
    expect(sanitizeEmailHtml(`<img src="cid:image001.png@01DD2A69">`)).toContain(
      "cid:image001.png@01DD2A69",
    );
  });

  it("does not corrupt a body that merely mentions onclick in its text", () => {
    expect(sanitizeEmailHtml("<p>The onclick= handler was removed</p>")).toContain(
      "The onclick= handler was removed",
    );
  });

  // Survey and campaign mail wraps its whole body in a <form>. Deleting the element with
  // everything inside it left a blank page where the mail should be.
  it("keeps what a form wraps, without the form", () => {
    const out = sanitizeEmailHtml(
      `<form action="https://survey.example/x" method="post"><table><tr><td>Rate our visit</td></tr></table><button type="submit">Send</button></form>`,
    );
    expect(out).toContain("<td>Rate our visit</td>");
    expect(out).toContain("Send");
    expect(out).not.toMatch(/<form|<button|action=/i);
  });

  it("keeps a picture the mail carries inside itself as a data: bitmap", () => {
    const img = `<img src="data:image/png;base64,iVBORw0KGgo=" width="96">`;
    expect(sanitizeEmailHtml(img)).toBe(img);
  });

  it("still drops data: everywhere else — an SVG picture, or a link", () => {
    const out = sanitizeEmailHtml(
      `<img src="data:image/svg+xml;base64,PHN2Zz4="><a href="data:image/png;base64,iVBORw0KGgo=">x</a>`,
    );
    expect(out).not.toContain("data:");
  });

  it("does not corrupt a body that merely mentions expression( or @import in its text", () => {
    const text = "<p>The expression(s) in the report, and the @import; note.</p>";
    expect(sanitizeEmailHtml(text)).toBe(text);
  });
});

// Outlook writes every mail's fonts, spacing, colours and table styles as
// <style><!-- ... --></style>. Treating that as a comment threw away the whole look of
// every mail an Outlook user sent: double-height lines, the wrong font, the wrong links.
describe("sanitizeEmailHtml — Outlook's stylesheet", () => {
  const outlook = `<html><head><style><!--
p.MsoNormal, li.MsoNormal, div.MsoNormal
	{margin:0cm;
	font-size:11.0pt;
	font-family:"Calibri",sans-serif;}
a:link, span.MsoHyperlink
	{color:#0563C1;}
--></style></head><body lang="EN-US" link="#0563C1"><p class="MsoNormal">Hi Team,<o:p></o:p></p></body></html>`;

  it("keeps the stylesheet Outlook wraps in <!-- -->", () => {
    const out = sanitizeEmailHtml(outlook);
    expect(out).toContain("p.MsoNormal, li.MsoNormal, div.MsoNormal");
    expect(out).toContain("margin:0cm;");
    expect(out).toContain('font-family:"Calibri",sans-serif;');
    expect(out).toContain("color:#0563C1;");
    expect(out).not.toContain("<!--");
    expect(out).toContain('<p class="MsoNormal">Hi Team,');
  });

  // A browser never applies a stylesheet that sits inside a real comment — Outlook's
  // <!--[if !mso]> blocks are exactly that — so neither may the reader.
  it("still drops a stylesheet that is inside a comment", () => {
    const out = sanitizeEmailHtml(
      `<!--[if !mso]><style>v\\:* {behavior:url(#default#VML);}</style><![endif]--><p>Body</p>`,
    );
    expect(out).not.toMatch(/<style|behavior/i);
    expect(out).toContain("<p>Body</p>");
  });

  it("takes the routes to script and to the network out of a kept stylesheet", () => {
    const out = sanitizeEmailHtml(
      `<style><!-- @import url(http://evil/x.css); p{width:expression(alert(1)); behavior:url(x.htc)} a{background:url(javascript:alert(1))} b{-moz-binding:url(x.xml#y)} --></style>`,
    );
    expect(out).not.toMatch(/@import|expression\s*\(|behavior|javascript:|-moz-binding/i);
    expect(out).toContain("<style>");
  });

  it("removes a handler on the style tag itself", () => {
    expect(sanitizeEmailHtml(`<style onload="steal()">p{}</style>`)).not.toMatch(/onload|steal/);
  });

  // In a real stylesheet a "<script>" is only text, but a stylesheet set aside by mistake
  // must not be able to bring a tag back with it either.
  it("never lets a tag out of a stylesheet", () => {
    expect(sanitizeEmailHtml(`<style>p{color:red}<script>x()</script></style>`)).not.toMatch(
      /<script/i,
    );
  });

  it("does not take a <style> written inside an attribute for a stylesheet", () => {
    const out = sanitizeEmailHtml(`<img alt="<style>"><script>alert(1)</script></style><p>After</p>`);
    expect(out).not.toMatch(/<script|alert/i);
    expect(out).toContain("<p>After</p>");
  });

  // NUL marks a set-aside stylesheet; one arriving in the mail must not be able to move or
  // copy one.
  it("ignores NUL characters that arrive in the mail", () => {
    const out = sanitizeEmailHtml(`\u00000\u0000<style>p{color:red}</style>\u00000\u0000`);
    expect(out.match(/<style>/g)).toHaveLength(1);
    expect(out).not.toContain("\u0000");
  });

  it("treats <!--> as the empty comment a browser does, not as the start of one", () => {
    const out = sanitizeEmailHtml(`<p>A<!-->B</p><p>C</p>`);
    expect(out).toContain("B");
    expect(out).toContain("<p>C</p>");
  });
});

// The stylesheet's own @import has to go, but not the rule after it. A font URL carries a
// ';' inside it, and cutting there left the URL's tail in front of the next rule.
describe("sanitizeEmailHtml — @import in a kept stylesheet", () => {
  // A stray quote outside an attribute value must not let a real stylesheet slip past the
  // cleaning as if it were part of the tag before it.
  it("still cleans a stylesheet that follows a stray quote in a tag", () => {
    for (const before of [`<p ">`, `<!x ">`, `</p ">`, `<p x=a">`]) {
      const out = sanitizeEmailHtml(
        `${before}<style>@import url(https://attacker.example/x.css); p{color:red}</style><p ">After</p>`,
      );
      expect(out, before).not.toMatch(/@import|attacker/);
      expect(out, before).toContain("p{color:red}");
    }
  });

  // Ordinary CSS that only looks like the dangerous kind must come through untouched.
  it("leaves scroll-behavior, a comment that says 'behavior:', and a media range alone", () => {
    expect(sanitizeEmailHtml(`<style>html{scroll-behavior:smooth;color:#333}</style>`)).toContain(
      "html{scroll-behavior:smooth;color:#333}",
    );
    const commented = sanitizeEmailHtml(
      `<style>/* keeps Outlook behavior: no gaps */ p{margin:0} td{padding:0}</style>`,
    );
    expect(commented).toContain("p{margin:0} td{padding:0}");
    expect(sanitizeEmailHtml(`<style>@media (width < 600px){ .col{display:block} }</style>`)).toContain(
      "@media (width < 600px){ .col{display:block} }",
    );
  });

  it("removes a whole @import whose URL has a ';' in it, and keeps the next rule", () => {
    const out = sanitizeEmailHtml(
      `<style>@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap");\nh1 {color:#e4002b;font-size:28px}</style>`,
    );
    expect(out).not.toMatch(/@import|googleapis|display=swap/);
    expect(out).toContain("h1 {color:#e4002b;font-size:28px}");
  });
});

// A plain-text mail must read exactly as it was typed. The reader used to show the copy
// cleaned for the matching rules, which lost whole threads.
describe("plainTextToHtml", () => {
  it("keeps the thread under an Original Message line, and a signature", () => {
    const text = "Please check.\n\n-----Original Message-----\nFrom: HP Case Owner\nThe part shipped.\n-- \nAnand";
    const out = plainTextToHtml(text);
    expect(out).toContain("-----Original Message-----\nFrom: HP Case Owner\nThe part shipped.\n-- \nAnand");
  });

  it("keeps a forwarded message", () => {
    const out = plainTextToHtml("FYI, see below.\n\n---------- Forwarded message ---------\nYour replacement part has shipped.");
    expect(out).toContain("Your replacement part has shipped.");
  });

  it("keeps every space, tab and =XX exactly as typed", () => {
    const out = plainTextToHtml("Part        Qty   Status\nSerial Number\t5CG1234XYZ\nserialnumber=5CG1234XYZ&page=2026");
    expect(out).toContain("Part        Qty   Status\nSerial Number\t5CG1234XYZ\n");
    expect(out).toContain("white-space:pre-wrap");
    expect(out).toContain("serialnumber=5CG1234XYZ&amp;page=2026");
  });

  it("shows markup as text and links web addresses and mail addresses", () => {
    const out = plainTextToHtml(
      "Fill the form <https://support.hp.com/in-en/document/c01234567>. Mail owner@example.com or see www.example.com, <script>x()</script>",
    );
    expect(out).toContain(
      '&lt;<a href="https://support.hp.com/in-en/document/c01234567">https://support.hp.com/in-en/document/c01234567</a>&gt;.',
    );
    expect(out).toContain('<a href="mailto:owner@example.com">owner@example.com</a>');
    expect(out).toContain('<a href="http://www.example.com">www.example.com</a>,');
    expect(out).toContain("&lt;script&gt;x()&lt;/script&gt;");
    expect(out).not.toContain("<script");
  });

  // A mislabelled UTF-16 part arrives with a NUL after every letter. A browser drops NUL
  // from text, so the reader shows "Hello", not "H?e?l?l?o?".
  it("returns nothing for an empty body, and drops NUL the way a browser does", () => {
    expect(plainTextToHtml("  \n ")).toBe("");
    const out = plainTextToHtml("H\u0000e\u0000l\u0000l\u0000o\u0000");
    expect(out).toContain(">Hello<");
    expect(out).not.toMatch(/\u0000|�/);
  });

  // Every text-only mail from anyone runs through the linker during ingest. A crafted run of
  // address characters used to take quadratic time: 16 s for 80 KB, about 40 min for 1 MB.
  it("stays fast on a long run that only looks like the start of an address", () => {
    for (const text of ["a.".repeat(100_000), `${"x-".repeat(50_000)}@${"b-".repeat(50_000)}`]) {
      const started = performance.now();
      plainTextToHtml(text);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe("toDisplayHtml", () => {
  it("shows the sender's HTML when the mail has any", () => {
    expect(toDisplayHtml({ html: "<p>Hi</p>", text: "Hi" })).toBe("<p>Hi</p>");
  });

  it("falls back to the exact text when there is no HTML part", () => {
    expect(toDisplayHtml({ html: "", text: "Hi\n-- \nAnand" })).toContain("Hi\n-- \nAnand");
    expect(toDisplayHtml({ html: "  ", text: "Hi" })).toContain("Hi");
  });
});

describe("resolveInlineImages", () => {
  const resolve = (cid: string) => (cid === "logo@hp" ? "/api/v1/x/attachments/a1" : null);

  it("resolves a URL-encoded reference (RFC 2392 writes @ as %40)", () => {
    expect(resolveInlineImages(`<img src="cid:logo%40hp">`, resolve)).toContain(
      `src="/api/v1/x/attachments/a1"`,
    );
  });

  it("resolves a table background and a CSS url(cid:), unquoted inside a quoted style", () => {
    const out = resolveInlineImages(
      `<td background="cid:logo@hp" style="background-image:url(cid:logo@hp)">x</td><style>.b{background:url('cid:logo@hp')}</style>`,
      resolve,
    );
    expect(out).toContain(`background="/api/v1/x/attachments/a1"`);
    expect(out).toContain(`style="background-image:url(/api/v1/x/attachments/a1)"`);
    expect(out).toContain(`.b{background:url(/api/v1/x/attachments/a1)}`);
  });

  // Inside a double-quoted style attribute a composer writes the inner quotes as &quot;.
  it("resolves a CSS url whose quotes arrive as &quot; or &#39;", () => {
    const out = resolveInlineImages(
      `<td style="background:url(&quot;cid:logo@hp&quot;);color:red"></td><td style="background:url(&#39;cid:logo@hp&#39;)"></td>`,
      resolve,
    );
    expect(out).toBe(
      `<td style="background:url(/api/v1/x/attachments/a1);color:red"></td><td style="background:url(/api/v1/x/attachments/a1)"></td>`,
    );
  });

  it("leaves a background it cannot resolve as it was", () => {
    const html = `<td background="cid:missing@hp">x</td>`;
    expect(resolveInlineImages(html, resolve)).toBe(html);
  });

  it("points a known cid at the attachment route", () => {
    expect(resolveInlineImages(`<img src="cid:logo@hp">`, resolve)).toContain(
      `src="/api/v1/x/attachments/a1"`,
    );
  });

  it("handles single-quoted and bare cid references", () => {
    expect(resolveInlineImages(`<img src='cid:logo@hp'>`, resolve)).toContain("/attachments/a1");
    expect(resolveInlineImages(`<img src=cid:logo@hp>`, resolve)).toContain("/attachments/a1");
  });

  // A message can reference a picture it does not carry. Leaving the cid: in place renders
  // a broken image icon in the middle of the customer's mail.
  it("drops a reference the message does not carry", () => {
    const out = resolveInlineImages(`<img src="cid:missing@hp">`, resolve);
    expect(out).not.toContain("cid:");
    expect(out).not.toContain("missing@hp");
  });

  it("leaves ordinary image sources alone", () => {
    const html = `<img src="https://hp.com/logo.png">`;
    expect(resolveInlineImages(html, resolve)).toBe(html);
  });
});
