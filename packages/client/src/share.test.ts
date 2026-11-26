// The owner sharing its session: on a session made with ownerMayShare, hello
// says mayShare, and shareLink / revokeSharedLink call the engine with the
// client's own link token, no API token.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlassClient } from "./index";
import { connectedClient, hello, installFakes } from "./testing/fakes";

describe("the owner sharing a session", () => {
  beforeEach(() => installFakes());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("says whether this connection may share, from hello", async () => {
    const off = await connectedClient({}, hello());
    expect(off.client.mayShare()).toBe(false);
    off.client.disconnect();
    const on = await connectedClient({}, hello({ mayShare: true }));
    expect(on.client.mayShare()).toBe(true);
    on.client.disconnect();
  });

  it("mints and revokes with the client's own link token", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: "l1", url: "ws://glass.test/v1/sessions/s1/connect?token=shared", rights: {} }), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await connectedClient({}, hello({ mayShare: true }));
    const link = await client.shareLink({ watch: "all" });
    expect(link.id).toBe("l1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("http://glass.test/v1/sessions/s1/links");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ watch: "all" });
    await client.revokeSharedLink("l1");
    const [rurl, rinit] = fetchMock.mock.calls[1] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(rurl).toBe("http://glass.test/v1/sessions/s1/links/l1");
    expect(rinit.method).toBe("DELETE");
    expect(rinit.headers.Authorization).toBe("Bearer tok");
    client.disconnect();
  });

  it("rejects when the engine refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '{"code":"unauthorized"}' })));
    const client = new GlassClient({ link: "ws://glass.test/v1/sessions/s1/connect?token=tok", reconnect: false });
    await expect(client.shareLink({ watch: "all" })).rejects.toThrow(/401/);
  });
});
