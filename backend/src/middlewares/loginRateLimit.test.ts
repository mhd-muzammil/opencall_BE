import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLoginRateLimiter, type LoginRateLimitOptions } from "./loginRateLimit.js";

// A fake login: password "right" succeeds, anything else is a 401.
async function startApp(options: LoginRateLimitOptions) {
  const app = express();
  app.set("trust proxy", true); // lets tests pick the client IP via X-Forwarded-For
  app.use(express.json());
  app.post("/login", createLoginRateLimiter(options), (request, response) => {
    if (request.body?.password === "right") {
      response.status(200).json({ ok: true });
    } else {
      response.status(401).json({ error: { message: "Invalid login credentials" } });
    }
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const login = (username: string, password: string, ip = "10.0.0.1") =>
    fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ username, password }),
    });
  return { server, login };
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

describe("login rate limiter", () => {
  it("blocks a username after 5 failures, even from different IPs", async () => {
    const app = await startApp({});
    server = app.server;
    for (let i = 0; i < 5; i += 1) {
      expect((await app.login("Admin", "wrong", `10.0.0.${i}`)).status).toBe(401);
    }
    const blocked = await app.login("admin", "right", "10.9.9.9");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("900");
    const body = await blocked.json();
    expect(body.error.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");
  });

  it("does not affect other usernames", async () => {
    const app = await startApp({});
    server = app.server;
    for (let i = 0; i < 5; i += 1) await app.login("victim", "wrong");
    expect((await app.login("someone-else", "right")).status).toBe(200);
  });

  it("clears the username counter after a successful login", async () => {
    const app = await startApp({});
    server = app.server;
    for (let i = 0; i < 4; i += 1) await app.login("user", "wrong");
    expect((await app.login("user", "right")).status).toBe(200);
    for (let i = 0; i < 4; i += 1) {
      expect((await app.login("user", "wrong")).status).toBe(401);
    }
    expect((await app.login("user", "right")).status).toBe(200);
  });

  it("blocks an IP spraying many usernames after 20 failures", async () => {
    const app = await startApp({});
    server = app.server;
    for (let i = 0; i < 20; i += 1) {
      expect((await app.login(`user${i}`, "wrong", "10.1.1.1")).status).toBe(401);
    }
    expect((await app.login("fresh-user", "right", "10.1.1.1")).status).toBe(429);
    expect((await app.login("fresh-user", "right", "10.2.2.2")).status).toBe(200);
  });

  it("never counts successful logins against a shared IP", async () => {
    const app = await startApp({});
    server = app.server;
    for (let i = 0; i < 50; i += 1) {
      expect((await app.login(`staff${i}`, "right", "10.3.3.3")).status).toBe(200);
    }
  });

  it("lets the user in again once the window expires", async () => {
    let clock = 1_000_000;
    const app = await startApp({ now: () => clock });
    server = app.server;
    for (let i = 0; i < 5; i += 1) await app.login("user", "wrong");
    expect((await app.login("user", "right")).status).toBe(429);
    clock += 15 * 60 * 1000;
    expect((await app.login("user", "right")).status).toBe(200);
  });
});
