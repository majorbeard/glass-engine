// requestGateTicket against a stubbed fetch: what it sends to the gate, what it
// returns, and how it reports a refusal.
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlassGateError, requestGateTicket } from "./index";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  });
  return calls;
}

describe("requestGateTicket", () => {
  it("asks the gate for a ticket and returns it with the engine", async () => {
    const calls = stubFetch(201, { engine: "https://engine.example", ticket: "t1" });
    const got = await requestGateTicket({ gate: "https://gate.example/", code: "abc" });
    expect(got).toEqual({ engine: "https://engine.example", ticket: "t1" });
    expect(calls[0]!.url).toBe("https://gate.example/v1/ticket");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ code: "abc" });
  });

  it("sends only what is given: nothing for an open gate", async () => {
    const calls = stubFetch(201, { engine: "e", ticket: "t" });
    await requestGateTicket({ gate: "https://gate.example" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
  });

  it("reports a refusal with the gate's code", async () => {
    stubFetch(401, { error: "this link has been used", code: "gate_refused" });
    const err = await requestGateTicket({ gate: "https://gate.example", code: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(GlassGateError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("gate_refused");
    expect(err.message).toBe("this link has been used");
  });

  it("reports how long to wait when rate limited", async () => {
    stubFetch(429, { error: "too many requests", code: "rate_limited" }, { "Retry-After": "12" });
    const err = await requestGateTicket({ gate: "https://gate.example" }).catch((e) => e);
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfterSeconds).toBe(12);
  });
});
