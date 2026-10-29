import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlassSession, redeemGlassTicket } from "./index";

// What createGlassSession posts for each form of its third argument.
function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ id: "s1", signalingUrl: "ws://host/v1/sessions/s1/signaling", protocolVersion: 1, contentHint: "motion" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function postedBody(fetchMock: ReturnType<typeof stubFetch>): unknown {
  const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body?: string };
  return init.body === undefined ? undefined : JSON.parse(init.body);
}

describe("createGlassSession options", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts no body when nothing is asked for", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host");
    expect(postedBody(fetchMock)).toBeUndefined();
  });

  it("still takes the audio-input flag alone", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host", undefined, true);
    expect(postedBody(fetchMock)).toEqual({ audioInput: true });
  });

  it("posts the content hint from an options object", async () => {
    const fetchMock = stubFetch();
    const session = await createGlassSession("http://host", undefined, { contentHint: "motion" });
    expect(postedBody(fetchMock)).toEqual({ contentHint: "motion" });
    expect(session.contentHint).toBe("motion");
  });

  it("posts both options together", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host", undefined, { audioInput: true, contentHint: "detail" });
    expect(postedBody(fetchMock)).toEqual({ audioInput: true, contentHint: "detail" });
  });

  it("posts the codec", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host", undefined, { codec: "vp8", contentHint: "detail" });
    expect(postedBody(fetchMock)).toEqual({ codec: "vp8", contentHint: "detail" });
  });

  it("posts no body for an options object that asks for nothing", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host", undefined, {});
    expect(postedBody(fetchMock)).toBeUndefined();
  });
});

describe("linkExpiresIn and tickets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts linkExpiresIn, 0 included", async () => {
    const fetchMock = stubFetch();
    await createGlassSession("http://host", undefined, { linkExpiresIn: 0 });
    expect(postedBody(fetchMock)).toEqual({ linkExpiresIn: 0 });
  });

  it("redeems a ticket with no API token", async () => {
    const fetchMock = stubFetch();
    const session = await redeemGlassTicket("a.b.c", "http://host");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("http://host/v1/tickets");
    expect(JSON.parse(init.body)).toEqual({ ticket: "a.b.c" });
    expect(init.headers.Authorization).toBeUndefined();
    expect(session.id).toBe("s1");
  });

  it("fails with the runtime's reason for a refused ticket", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => JSON.stringify({ error: "ticket already used", code: "ticket_used" }) })));
    await expect(redeemGlassTicket("a.b.c", "http://host")).rejects.toThrow("Failed to redeem ticket (401): ticket already used (ticket_used)");
  });
});
