import { describe, expect, it } from "vitest";
import { RepairWaitPolicy } from "./repair_wait";

// The repair wait engages only on a long path with resends, follows the round
// trip, and lets go after a minute without a resend request.

describe("RepairWaitPolicy", () => {
  it("never engages on a short path, however many resends", () => {
    const p = new RepairWaitPolicy();
    for (let t = 0; t < 30; t++) expect(p.update(t * 1000, t * 10, 180)).toBeNull();
    expect(p.target).toBe(0);
  });

  it("never engages on a long path without resends", () => {
    const p = new RepairWaitPolicy();
    for (let t = 0; t < 30; t++) expect(p.update(t * 1000, 0, 400)).toBeNull();
  });

  it("engages at the third resend request on a long path, at the round trip plus 30 ms", () => {
    const p = new RepairWaitPolicy();
    expect(p.update(0, 0, 400)).toBeNull();
    expect(p.update(1000, 2, 400)).toBeNull();
    expect(p.update(2000, 3, 400)).toBe(430);
  });

  it("does not count requests made before it first looked", () => {
    const p = new RepairWaitPolicy();
    expect(p.update(0, 50, 400)).toBeNull();
    expect(p.update(1000, 51, 400)).toBeNull();
  });

  it("keeps the target through small changes of the round trip and follows large ones", () => {
    const p = new RepairWaitPolicy();
    p.update(0, 0, 400);
    expect(p.update(1000, 3, 400)).toBe(430);
    expect(p.update(2000, 3, 420)).toBeNull();
    expect(p.update(3000, 3, 600)).toBe(630);
  });

  it("keeps the last round trip known when a poll has none", () => {
    const p = new RepairWaitPolicy();
    p.update(0, 0, 400);
    expect(p.update(1000, 3, null)).toBe(430);
  });

  it("lets go 60 s after the last resend request", () => {
    const p = new RepairWaitPolicy();
    p.update(0, 0, 400);
    expect(p.update(1000, 3, 400)).toBe(430);
    expect(p.update(60_000, 3, 400)).toBeNull();
    expect(p.update(61_001, 3, 400)).toBe(0);
  });

  it("caps the target at the 4 s the browser accepts", () => {
    const p = new RepairWaitPolicy();
    p.update(0, 0, 5000);
    expect(p.update(1000, 3, 5000)).toBe(4000);
  });
});
