import { describe, expect, it } from "vitest";
import { resolveInlineImages, sanitizeEmailHtml } from "./htmlSanitizer.js";

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
});

describe("resolveInlineImages", () => {
  const resolve = (cid: string) => (cid === "logo@hp" ? "/api/v1/x/attachments/a1" : null);

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
