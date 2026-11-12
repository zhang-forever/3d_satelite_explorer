// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import GlobeScene from "@/components/GlobeScene";
import type { PropagatedObject } from "@/lib/orbit";

const rendererSpies = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn() }));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setPixelRatio() {}
      setSize() {}
      render = rendererSpies.render;
      dispose = rendererSpies.dispose;
    },
    TextureLoader: class {
      load(_url: string, onLoad: (texture: THREE.Texture) => void) {
        const texture = new actual.Texture();
        onLoad(texture);
        return texture;
      }
    }
  };
});
vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({
  OrbitControls: class { update() {} dispose() {} }
}));

function satellite(): PropagatedObject {
  return {
    id: "25544", name: "TEST SATELLITE", objectId: "1998-067A", noradId: "25544",
    epoch: "2026-09-30T00:00:00Z", latitude: 0, longitude: 0, altitudeKm: 420, speedKmS: 7.6,
    positionKm: { x: 7000, y: 0, z: 0 }, scene: { x: 1.1, y: 0, z: 0 }, error: null,
    objectType: "payload", groupId: "active", inShadow: false
  };
}

describe("globe live selection and resource cleanup", () => {
  let frameCallback: FrameRequestCallback;
  beforeEach(() => {
    rendererSpies.render.mockClear();
    rendererSpies.dispose.mockClear();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
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

  function currentScene() {
    act(() => frameCallback(0));
    return rendererSpies.render.mock.calls.at(-1)![0] as THREE.Scene;
  }

  it("moves the selection ring when a pooled satellite object changes in place", () => {
    const object = satellite();
    const props = { selectedId: object.id, track: [], onSelect: vi.fn(), sceneTime: new Date() };
    const view = render(<GlobeScene {...props} objects={[object]} />);
    const scene = currentScene();
    const ring = scene.children.find((child) => child instanceof THREE.Sprite)! as THREE.Sprite;
    expect(ring.position.x).toBe(1.1);
    object.scene.x = 0.5;
    object.scene.y = 1;
    view.rerender(<GlobeScene {...props} objects={[object]} />);
    expect(ring.position.x).toBe(0.5);
    expect(ring.position.y).toBe(1);
  });

  it("moves the coverage footprint when the same satellite changes latitude", () => {
    const object = satellite();
    const props = { selectedId: object.id, track: [], onSelect: vi.fn(), sceneTime: new Date() };
    const view = render(<GlobeScene {...props} objects={[object]} />);
    const scene = currentScene();
    const footprint = scene.children.find((child) => child instanceof THREE.LineLoop &&
      child.geometry.getAttribute("position").count === 97)! as THREE.LineLoop;
    const before = Array.from(footprint.geometry.getAttribute("position").array);
    object.latitude = 45;
    view.rerender(<GlobeScene {...props} objects={[object]} />);
    expect(Array.from(footprint.geometry.getAttribute("position").array)).not.toEqual(before);
  });

  it("preserves the indexed payload primitives' triangle counts when merging", () => {
    render(<GlobeScene objects={[]} selectedId={null} track={[]} onSelect={vi.fn()} sceneTime={new Date()} />);
    const scene = currentScene();
    const payload = scene.children.find((child) => child instanceof THREE.InstancedMesh)! as THREE.InstancedMesh;
    // Three boxes (12 triangles each), a cone (12), and a cylinder (16).
    expect(payload.geometry.getAttribute("position").count / 3).toBe(64);
  });

  it("disposes the grown instance buffer and scene textures when unmounted", () => {
    const objects = Array.from({ length: 1100 }, (_, index) => ({ ...satellite(), id: String(index) }));
    const view = render(<GlobeScene objects={objects} selectedId={null} track={[]} onSelect={vi.fn()} sceneTime={new Date()} />);
    const scene = currentScene();
    const instance = scene.children.find((child) => child instanceof THREE.InstancedMesh && child.count === 1100)! as THREE.InstancedMesh;
    const disposeInstance = vi.fn();
    instance.addEventListener("dispose", disposeInstance);
    const earth = scene.children.find((child) => child instanceof THREE.Mesh &&
      child.material instanceof THREE.MeshPhongMaterial && child.material.normalMap)! as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>;
    const disposeTexture = vi.fn();
    earth.material.map!.addEventListener("dispose", disposeTexture);
    view.unmount();
    expect(disposeInstance).toHaveBeenCalledOnce();
    expect(disposeTexture).toHaveBeenCalledOnce();
    expect(rendererSpies.dispose).toHaveBeenCalledOnce();
  });
});
