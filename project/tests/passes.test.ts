import { describe, expect, it } from "vitest";
import type { OmmRecord } from "@/lib/orbit";
import { azimuthToCompass, predictPasses } from "@/lib/passes";

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

describe("predictPasses", () => {
  it("returns ordered passes with positive duration and elevation above threshold", () => {
    const passes = predictPasses(
      iss,
      { latitudeDeg: 40.0, longitudeDeg: 116.4 },
      new Date("2026-04-28T05:00:00Z"),
      { windowHours: 48, minElevationDeg: 10, maxResults: 4 }
    );

    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      expect(pass.peakElevationDeg).toBeGreaterThanOrEqual(10);
      expect(new Date(pass.endAt).getTime()).toBeGreaterThan(new Date(pass.startAt).getTime());
      expect(pass.durationSec).toBeGreaterThan(0);
    }
    for (let i = 1; i < passes.length; i += 1) {
      expect(new Date(passes[i].startAt).getTime()).toBeGreaterThan(
        new Date(passes[i - 1].startAt).getTime()
      );
    }
  });

  it("returns no passes for an unreachable observer threshold", () => {
    const passes = predictPasses(
      iss,
      { latitudeDeg: 40.0, longitudeDeg: 116.4 },
      new Date("2026-04-28T05:00:00Z"),
      { windowHours: 24, minElevationDeg: 89.5, maxResults: 4 }
    );
    expect(passes.length).toBe(0);
  });
});

describe("azimuthToCompass", () => {
  it.each([
    [0, "N"],
    [90, "E"],
    [180, "S"],
    [270, "W"],
    [45, "NE"],
    [359, "N"]
  ])("maps %i deg to %s", (azimuth, expected) => {
    expect(azimuthToCompass(azimuth)).toBe(expected);
  });
});
