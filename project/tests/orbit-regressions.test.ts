import { describe, expect, it, vi } from "vitest";
import { propagate } from "satellite.js";
import {
  calculateRendezvous,
  createSatrec,
  propagateOmm,
  sampleOrbitTrack,
  scanRendezvous,
  type OmmRecord
} from "@/lib/orbit";

vi.mock("satellite.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("satellite.js")>();
  return { ...original, propagate: vi.fn(original.propagate) };
});

const primary: OmmRecord = {
  OBJECT_NAME: "TEST PRIMARY", OBJECT_ID: "1998-067A", NORAD_CAT_ID: 25544,
  EPOCH: "2026-04-28T04:47:58.358400", MEAN_MOTION: 15.49001185,
  ECCENTRICITY: 0.00070642, INCLINATION: 51.632, RA_OF_ASC_NODE: 187.5201,
  ARG_OF_PERICENTER: 0, MEAN_ANOMALY: 0, BSTAR: 0.00015976466,
  MEAN_MOTION_DOT: 0.00008365, MEAN_MOTION_DDOT: 0
};

describe("orbital input and encounter regressions", () => {
  it.each([
    "2026-04-28T04:47:58.358400Z",
    "2026-04-28T04:47:58.358400z",
    "2026-04-28T12:47:58.358400+08:00",
    "2026-04-27T23:47:58.358400-0500"
  ])("propagates the same instant for the zoned epoch %s", (epoch) => {
    const at = new Date("2026-04-28T05:00:00Z");
    const expected = propagateOmm(primary, at)!;
    const actual = propagateOmm({ ...primary, EPOCH: epoch }, at);
    expect(actual).not.toBeNull();
    expect(actual!.positionKm).toEqual(expected.positionKm);
    expect(actual!.speedKmS).toEqual(expected.speedKmS);
  });

  it("rejects an invalid epoch before initializing the propagator", () => {
    expect(() => createSatrec({ ...primary, EPOCH: "not-a-date" })).toThrow(/epoch/i);
  });

  it("does not throw when a selected record cannot produce an orbit track", () => {
    expect(sampleOrbitTrack({ ...primary, MEAN_MOTION: "invalid" },
      new Date("2026-04-28T05:00:00Z"), "stations")).toEqual([]);
  });

  it("refines encounters between coarse samples before applying the distance cutoff", () => {
    const secondary = { ...primary, NORAD_CAT_ID: 99999, INCLINATION: 70 };
    const start = new Date(Date.parse(`${primary.EPOCH}Z`) - 150_000);
    const options = { windowHours: 1 / 6, stepMinutes: 5, refinementSeconds: 30 };
    const reference = calculateRendezvous(primary, secondary, start, options)!;
    expect(reference.missDistanceKm).toBeLessThan(10);
    const hits = scanRendezvous(primary, [{ groupId: "test", record: secondary }],
      start, { ...options, hitMaxDistanceKm: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].closestAt).toBe(reference.closestAt);
    expect(hits[0].missDistanceKm).toBeCloseTo(reference.missDistanceKm, 8);
  });

  it("still excludes encounters outside the cutoff after refinement", () => {
    const secondary = { ...primary, NORAD_CAT_ID: 99999, INCLINATION: 70, MEAN_ANOMALY: 10 };
    const start = new Date(Date.parse(`${primary.EPOCH}Z`) - 150_000);
    const options = { windowHours: 1 / 6, stepMinutes: 5, refinementSeconds: 30 };
    const reference = calculateRendezvous(primary, secondary, start, options)!;
    expect(reference.missDistanceKm).toBeGreaterThan(10);
    expect(scanRendezvous(primary, [{ groupId: "test", record: secondary }], start,
      { ...options, hitMaxDistanceKm: 10 })).toEqual([]);
  });

  it("shares refined primary states across secondary candidates", () => {
    vi.mocked(propagate).mockClear();
    const start = new Date(Date.parse(`${primary.EPOCH}Z`) - 150_000);
    const secondary = { ...primary, NORAD_CAT_ID: 99999, INCLINATION: 70 };
    const hits = scanRendezvous(primary, [
      { groupId: "test", record: secondary },
      { groupId: "test", record: { ...secondary, NORAD_CAT_ID: 99998 } }
    ], start, { windowHours: 1 / 6, stepMinutes: 5, refinementSeconds: 30, hitMaxDistanceKm: 10 });
    expect(hits).toHaveLength(2);
    const refinedAt = start.getTime() + 150_000;
    const primaryCalls = vi.mocked(propagate).mock.calls.filter(([satrec, at]) =>
      satrec.satnum === String(primary.NORAD_CAT_ID) &&
      at instanceof Date && at.getTime() === refinedAt);
    expect(primaryCalls).toHaveLength(1);
  });

  it.each([30, 37])("keeps cached deep-space results independent of candidate order at %i s", (refinementSeconds) => {
    const geo = { ...primary, MEAN_MOTION: 1.0027, ECCENTRICITY: 0.01, INCLINATION: 10 };
    const secondaries = [10, 25, 40].map((anomaly, index) => ({
      groupId: "geo", record: { ...geo, NORAD_CAT_ID: 99000 + index, MEAN_ANOMALY: anomaly }
    }));
    const start = new Date("2026-04-28T05:00:00Z");
    const options = { windowHours: 24, stepMinutes: 5, refinementSeconds, hitMaxDistanceKm: 100_000 };
    const hits = scanRendezvous(geo, secondaries, start, options);
    expect(hits).toHaveLength(secondaries.length);
    expect(scanRendezvous(geo, [...secondaries].reverse(), start, options)).toEqual(hits);
    for (const secondary of secondaries) {
      const reference = calculateRendezvous(geo, secondary.record, start, options)!;
      const hit = hits.find((item) => item.noradId === String(secondary.record.NORAD_CAT_ID))!;
      expect(hit.closestAt).toBe(reference.closestAt);
      expect(hit.missDistanceKm).toBeCloseTo(reference.missDistanceKm, 8);
      expect(hit.relativeSpeedKmS).toBeCloseTo(reference.relativeSpeedKmS, 8);
    }
  });
});
