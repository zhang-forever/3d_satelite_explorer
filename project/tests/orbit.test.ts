import { describe, expect, it } from "vitest";
import {
  allocatePropagationBuffers,
  altitudeRangeKm,
  calculateRendezvous,
  createSatrec,
  dataAgeHours,
  dedupeByNorad,
  objectClass,
  orbitalPeriodMinutes,
  PROPAGATION_VALID,
  propagateBatch,
  propagateOmm,
  quantizeDown,
  sampleOrbitTrack,
  scanRendezvous
} from "@/lib/orbit";
import type { OmmRecord } from "@/lib/orbit";

const iss: OmmRecord = {
  OBJECT_NAME: "ISS (ZARYA)",
  OBJECT_ID: "1998-067A",
  EPOCH: "2026-04-28T04:47:58.358400",
  MEAN_MOTION: 15.49001185,
  ECCENTRICITY: 0.00070642,
  INCLINATION: 51.632,
  RA_OF_ASC_NODE: 187.5201,
  ARG_OF_PERICENTER: 359.4554,
  MEAN_ANOMALY: 0.6426,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: "U",
  NORAD_CAT_ID: 25544,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 56400,
  BSTAR: 0.00015976466,
  MEAN_MOTION_DOT: 0.00008365,
  MEAN_MOTION_DDOT: 0
};

describe("orbit utilities", () => {
  it("propagates an OMM JSON record into valid geodetic coordinates", () => {
    const propagated = propagateOmm(iss, new Date("2026-04-28T05:00:00.000Z"), "stations");

    expect(propagated).not.toBeNull();
    expect(propagated?.latitude).toBeGreaterThanOrEqual(-90);
    expect(propagated?.latitude).toBeLessThanOrEqual(90);
    expect(propagated?.longitude).toBeGreaterThanOrEqual(-180);
    expect(propagated?.longitude).toBeLessThanOrEqual(180);
    expect(propagated?.altitudeKm).toBeGreaterThan(350);
    expect(propagated?.altitudeKm).toBeLessThan(500);
    expect(propagated?.speedKmS).toBeGreaterThan(7);
    expect(propagated?.speedKmS).toBeLessThan(8);
  });

  it("samples a bounded future track for the selected object", () => {
    const track = sampleOrbitTrack(iss, new Date("2026-04-28T05:00:00.000Z"), "stations");
    const first = track[0].scene;
    const last = track[track.length - 1].scene;
    const closingDistance = Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);

    expect(track.length).toBeGreaterThan(80);
    expect(track.length).toBeLessThanOrEqual(241);
    expect(closingDistance).toBeLessThan(0.08);
    expect(orbitalPeriodMinutes(iss)).toBeGreaterThan(90);
    expect(orbitalPeriodMinutes(iss)).toBeLessThan(100);
  });

  it("classifies debris and computes data age defensively", () => {
    expect(objectClass({ ...iss, OBJECT_NAME: "FENGYUN 1C DEB" })).toBe("debris");
    expect(dataAgeHours("not-a-date")).toBeNull();
  });

  it("computes closest approach between two specified objects", () => {
    const result = calculateRendezvous(
      iss,
      { ...iss, OBJECT_NAME: "POISK", NORAD_CAT_ID: 36086 },
      new Date("2026-04-28T05:00:00.000Z"),
      { windowHours: 1, stepMinutes: 5, refinementSeconds: 30 }
    );

    expect(result).not.toBeNull();
    expect(result?.primaryId).toBe("25544");
    expect(result?.secondaryId).toBe("36086");
    expect(result?.missDistanceKm).toBeLessThan(0.01);
    expect(result?.relativeSpeedKmS).toBeLessThan(0.01);
    expect(result?.samples).toBeGreaterThan(10);
  });

  it("returns null for malformed orbital records", () => {
    const bad = { ...iss, MEAN_MOTION: "not-a-number" };
    expect(propagateOmm(bad, new Date("2026-04-28T05:00:00.000Z"), "stations")).toBeNull();
  });

  it("estimates altitude range from mean motion and eccentricity", () => {
    const range = altitudeRangeKm(iss);
    expect(range).not.toBeNull();
    expect(range?.minKm).toBeGreaterThan(380);
    expect(range?.maxKm).toBeLessThan(440);
    expect(range?.maxKm).toBeGreaterThanOrEqual(range?.minKm ?? 0);
  });

  it("scans secondaries against a primary and pre-filters by altitude", () => {
    const twin: OmmRecord = { ...iss, OBJECT_NAME: "ISS TWIN", NORAD_CAT_ID: 99999 };
    const geoLike: OmmRecord = {
      ...iss,
      OBJECT_NAME: "GEO_FAR",
      NORAD_CAT_ID: 88888,
      MEAN_MOTION: 1.0027,
      ECCENTRICITY: 0.0001
    };
    const hits = scanRendezvous(
      iss,
      [
        { groupId: "stations", record: twin },
        { groupId: "geo", record: geoLike }
      ],
      new Date("2026-04-28T05:00:00.000Z"),
      { windowHours: 2, stepMinutes: 5, refinementSeconds: 30, hitMaxDistanceKm: 50 }
    );

    expect(hits.length).toBe(1);
    expect(hits[0].noradId).toBe("99999");
    expect(hits[0].missDistanceKm).toBeLessThan(0.5);
  });

  it("dedupes duplicate NORAD entries and skips stale TLEs in scans", () => {
    const twin: OmmRecord = { ...iss, OBJECT_NAME: "ISS TWIN", NORAD_CAT_ID: 99999 };
    const duplicatePrimary: OmmRecord = { ...iss };
    const stale: OmmRecord = {
      ...iss,
      OBJECT_NAME: "ISS STALE",
      NORAD_CAT_ID: 77777,
      EPOCH: "2025-01-01T00:00:00.000"
    };
    const hits = scanRendezvous(
      iss,
      [
        { groupId: "stations", record: duplicatePrimary },
        { groupId: "stations", record: twin },
        { groupId: "stations", record: twin },
        { groupId: "stations", record: stale }
      ],
      new Date("2026-04-28T05:00:00.000Z"),
      { windowHours: 2, stepMinutes: 5, refinementSeconds: 30, hitMaxDistanceKm: 50 }
    );

    expect(hits.length).toBe(1);
    expect(hits[0].noradId).toBe("99999");
  });

  it("reports scan progress against the secondary count", () => {
    const twin: OmmRecord = { ...iss, OBJECT_NAME: "ISS TWIN", NORAD_CAT_ID: 99999 };
    const seen: Array<[number, number]> = [];

    scanRendezvous(
      iss,
      [{ groupId: "stations", record: twin }],
      new Date("2026-04-28T05:00:00.000Z"),
      { windowHours: 1, stepMinutes: 5, refinementSeconds: 30, hitMaxDistanceKm: 50 },
      (done, total) => seen.push([done, total])
    );

    expect(seen.at(-1)).toEqual([1, 1]);
  });

  it("dedupes rows that share a NORAD id, keeping the first occurrence", () => {
    const rows = [
      { groupId: "active", record: iss },
      { groupId: "starlink", record: { ...iss } },
      { groupId: "stations", record: { ...iss, NORAD_CAT_ID: 36086, OBJECT_NAME: "POISK" } }
    ];

    const unique = dedupeByNorad(rows);

    expect(unique).toHaveLength(2);
    expect(unique[0].groupId).toBe("active");
    expect(unique[1].record.NORAD_CAT_ID).toBe(36086);
  });

  it("snaps timestamps down to a fixed grid", () => {
    expect(quantizeDown(12_345, 5_000)).toBe(10_000);
    expect(quantizeDown(10_000, 5_000)).toBe(10_000);
    expect(quantizeDown(14_999, 5_000)).toBe(10_000);
    expect(quantizeDown(15_000, 5_000)).toBe(15_000);
    expect(Number.isNaN(quantizeDown(Number.NaN, 5_000))).toBe(true);
  });

  it("propagates a set into reusable buffers, matching the single-object path", () => {
    const at = new Date("2026-04-28T05:00:00.000Z");
    const twin: OmmRecord = { ...iss, OBJECT_NAME: "ISS TWIN", NORAD_CAT_ID: 99999 };
    const satrecs = [createSatrec(iss), createSatrec(twin), null];
    const sink = allocatePropagationBuffers(satrecs.length);

    const valid = propagateBatch(satrecs, at, sink);
    const single = propagateOmm(iss, at, "stations");

    expect(valid).toBe(2);
    expect(sink.flags[2]).toBe(0);
    expect(sink.flags[0] & PROPAGATION_VALID).toBe(PROPAGATION_VALID);
    expect(single).not.toBeNull();
    expect(sink.geo[0]).toBeCloseTo(single!.latitude, 3);
    expect(sink.geo[1]).toBeCloseTo(single!.longitude, 3);
    expect(sink.geo[2]).toBeCloseTo(single!.altitudeKm, 1);
    expect(sink.speed[0]).toBeCloseTo(single!.speedKmS, 3);
    expect(sink.scene[0]).toBeCloseTo(single!.scene.x, 5);
    expect(sink.scene[1]).toBeCloseTo(single!.scene.y, 5);
    expect(sink.scene[2]).toBeCloseTo(single!.scene.z, 5);
    expect(sink.ecf[0]).toBeCloseTo(single!.positionKm.x, 2);
  });

  it("clears stale flags when the same buffers are reused", () => {
    const at = new Date("2026-04-28T05:00:00.000Z");
    const sink = allocatePropagationBuffers(2);
    sink.flags[1] = PROPAGATION_VALID;
    sink.flags[0] = PROPAGATION_VALID;

    propagateBatch([createSatrec(iss), null], at, sink);

    expect(sink.flags[0] & PROPAGATION_VALID).toBe(PROPAGATION_VALID);
    expect(sink.flags[1]).toBe(0);
  });
});
