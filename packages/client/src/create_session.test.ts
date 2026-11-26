import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlassSession, mintGlassLink, redeemGlassTicket, revokeGlassLink } from "./index";

const LINK = { id: "4776be7c9390e016", url: "ws://host/v1/sessions/s1/connect?token=t", rights: { watch: "all", publish: [], control: "all", owner: true } };

// The engine's answer to POST /v1/sessions (protocol v3).
function stubFetch(extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "s1", protocolVersion: 3, link: LINK, sources: [{ id: "src1", kind: "browser", state: "live", capabilities: {}, inputMode: "floor", inspect: false, contentHint: "motion" }], ...extra }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body?: string };
  return init.body === undefined ? undefined : JSON.parse(init.body);
}

describe("createGlassSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts a browser and its options, and returns the session with its link and sources", async () => {
    const fetchMock = stubFetch();
    const session = await createGlassSession({
      baseUrl: "http://host",
      apiToken: "api",
      sources: [{ kind: "browser", audioInput: true, contentHint: "motion", codec: "vp8", inputMode: "free", inspect: true, url: "https://a.test/" }],
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://host/v1/sessions");
    expect(init.headers.Authorization).toBe("Bearer api");
    expect(postedBody(fetchMock)).toEqual({
      sources: [{ kind: "browser", audioInput: true, contentHint: "motion", codec: "vp8", inputMode: "free", inspect: true, url: "https://a.test/" }],
    });
    expect(session.link.url).toBe(LINK.url);
    expect(session.sources[0]?.contentHint).toBe("motion");
  });

  it("posts a session whose members publish: no sources, its limit and simulcast", async () => {
    const fetchMock = stubFetch({ sources: [], maxMembers: 2, simulcast: true });
    const session = await createGlassSession({ baseUrl: "http://host", maxMembers: 2, simulcast: true });
    expect(postedBody(fetchMock)).toEqual({ maxMembers: 2, simulcast: true });
    expect(session.sources).toEqual([]);
    expect(session.maxMembers).toBe(2);
  });

  it("posts linkExpiresIn, 0 included, and record", async () => {
    const fetchMock = stubFetch();
    await createGlassSession({ baseUrl: "http://host", sources: [{ kind: "browser" }], linkExpiresIn: 0, record: true });
    expect(postedBody(fetchMock)).toEqual({ sources: [{ kind: "browser" }], linkExpiresIn: 0, record: true });
  });

  it("refuses an engine that speaks another protocol version", async () => {
    stubFetch({ protocolVersion: 2 });
    await expect(createGlassSession({ baseUrl: "http://host" })).rejects.toThrow("protocol v2");
  });
});

describe("tickets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("redeems a ticket with no API token, with its watch links", async () => {
    const fetchMock = stubFetch({ watchLinks: [{ ...LINK, id: "w1" }] });
    const session = await redeemGlassTicket({ ticket: "a.b.c", baseUrl: "http://host" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("http://host/v1/tickets");
    expect(JSON.parse(init.body)).toEqual({ ticket: "a.b.c" });
    expect(init.headers.Authorization).toBeUndefined();
    expect(session.id).toBe("s1");
    expect(session.watchLinks?.[0]?.id).toBe("w1");
  });

  it("fails with the runtime's reason for a refused ticket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => JSON.stringify({ error: "ticket already used", code: "ticket_used" }) })));
    await expect(redeemGlassTicket({ ticket: "a.b.c", baseUrl: "http://host" })).rejects.toThrow("Failed to redeem ticket (401): ticket already used (ticket_used)");
  });
});

describe("links", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints a link with rights by kind and a lifetime, and returns it", async () => {
    const minted = { id: "7ccc96e109d9b5cc", url: "ws://host/v1/sessions/s1/connect?token=w", rights: { watch: "all", publish: [], control: [], owner: false }, expiresAt: "2026-11-16T10:00:00Z" };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => minted }));
    vi.stubGlobal("fetch", fetchMock);
    const link = await mintGlassLink({ sessionId: "s1", rights: { watch: "all", control: ["browser"], expiresIn: 3600 }, baseUrl: "http://host", apiToken: "api" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("http://host/v1/sessions/s1/links");
    expect(JSON.parse(init.body)).toEqual({ watch: "all", control: ["browser"], expiresIn: 3600 });
    expect(init.headers.Authorization).toBe("Bearer api");
    expect(link).toEqual(minted);
  });

  it("revokes a link by its id", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await revokeGlassLink({ sessionId: "s1", linkId: "7ccc96e109d9b5cc", baseUrl: "http://host", apiToken: "api" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe("http://host/v1/sessions/s1/links/7ccc96e109d9b5cc");
    expect(init.method).toBe("DELETE");
  });
});
