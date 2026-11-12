// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import GlobeScene from "@/components/GlobeScene";

const state = vi.hoisted(() => ({
  render: vi.fn(),
  controls: [] as Array<{ autoRotate: boolean; update: ReturnType<typeof vi.fn> }>
}));

vi.mock("three", async (importOriginal) => {
  const original = await importOriginal<typeof import("three")>();
  return {
    ...original,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setPixelRatio() {}
      setSize() {}
      render = state.render;
      dispose() {}
    },
    TextureLoader: class {
      load() { return new original.Texture(); }
    }
  };
});

vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class {
    autoRotate = false;
    update = vi.fn();
    constructor() { state.controls.push(this); }
    dispose() {}
  }
}));

describe("Earth-fixed scene", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    state.render.mockClear();
    state.controls.length = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      beginPath() {}, arc() {}, stroke() {}
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function advanceFrames(count: number) {
    act(() => {
      for (let i = 0; i < count; i += 1) {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(i * 1000 / 60));
      }
    });
  }

  it("keeps geography aligned with the observer across frames, time jumps and camera rotation", () => {
    const props = {
      objects: [], selectedId: null, track: [], onSelect: vi.fn(),
      observer: { latitudeDeg: 40, longitudeDeg: 116.4 },
      sceneTime: new Date("2026-10-05T12:00:00Z"), autoRotate: false
    };
    const view = render(<GlobeScene {...props} />);
    advanceFrames(1);
    const scene = state.render.mock.calls[0][0] as THREE.Scene;
    const earth = scene.children.find((child) => child instanceof THREE.Mesh &&
      child.geometry instanceof THREE.SphereGeometry && child.geometry.parameters.radius === 1)!;
    const observer = scene.children.find((child) => child.renderOrder === 2)!;
    const initialRotation = earth.quaternion.clone();
    const initialObserver = observer.position.clone();

    advanceFrames(120);
    expect(earth.quaternion.equals(initialRotation)).toBe(true);
    expect(observer.position.equals(initialObserver)).toBe(true);
    expect(state.controls[0].autoRotate).toBe(false);

    view.rerender(<GlobeScene {...props} autoRotate sceneTime={new Date("2026-10-05T18:00:00Z")} />);
    advanceFrames(120);
    expect(earth.quaternion.equals(initialRotation)).toBe(true);
    expect(observer.position.equals(initialObserver)).toBe(true);
    expect(state.controls[0].autoRotate).toBe(true);
    expect(state.controls[0].update).toHaveBeenCalledTimes(241);
  });
});
