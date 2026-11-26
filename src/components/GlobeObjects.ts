/**
 * Per-object rendering helpers for the globe: instanced geometry factories,
 * capacity management, and the per-catalog color lookup. Kept out of
 * `GlobeScene` so that file only owns the scene lifecycle.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import { CATALOGS } from "@/lib/catalogs";
import { OBJECT_CLASS_COLORS, type ObjectClass, type PropagatedObject } from "@/lib/orbit";

const GROUP_COLOR: Record<string, string> = Object.fromEntries(
  CATALOGS.map((catalog) => [catalog.id, catalog.color])
);

export function colorFor(obj: PropagatedObject) {
  return GROUP_COLOR[obj.groupId] ?? OBJECT_CLASS_COLORS[obj.objectType];
}

export const SELECTED_COLOR = "#fbbf24";
export const SHADOW_DIM = 0.32;
const EARTH_MU = 398600.4418;
export const EARTH_RADIUS_KM = 6378.137;

/** Capacity is grown on demand — no point reserving 10k instances per class. */
export const INITIAL_CAPACITY = 1024;
export const CLICK_SLOP_PX = 5;

export type InstancedIndexEntry = {
  group: ObjectClass;
  index: number;
  /** Slot in the shared glow buffer, used to hide one dot while following. */
  glowIndex: number;
  baseColor: string;
  inShadow: boolean;
  object: PropagatedObject;
};

// -- tiny geometry factories for each object type --

function geoPayload() {
  // central bus (box shape)
  const bus = new THREE.BoxGeometry(0.009, 0.009, 0.014);
  // solar panels (two large flat rectangles)
  const panelL = new THREE.BoxGeometry(0.022, 0.002, 0.008);
  panelL.translate(-0.016, 0, 0);
  const panelR = new THREE.BoxGeometry(0.022, 0.002, 0.008);
  panelR.translate(0.016, 0, 0);
  // antenna dish (small cone pointing up)
  const dish = new THREE.ConeGeometry(0.005, 0.008, 6);
  dish.translate(0, 0.008, 0);
  // antenna stem
  const stem = new THREE.CylinderGeometry(0.0012, 0.0012, 0.006, 4);
  stem.translate(0, 0.004, 0);
  return mergeGeometries([bus, panelL, panelR, dish, stem]);
}

function geoDebris() {
  const geo = new THREE.TetrahedronGeometry(0.013, 0);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, pos.getX(i) * (0.6 + Math.random() * 0.8));
    pos.setY(i, pos.getY(i) * (0.6 + Math.random() * 0.8));
    pos.setZ(i, pos.getZ(i) * (0.6 + Math.random() * 0.8));
  }
  geo.computeVertexNormals();
  return geo;
}

function geoRocket() {
  const body = new THREE.CylinderGeometry(0.007, 0.009, 0.026, 8);
  const nose = new THREE.ConeGeometry(0.007, 0.01, 8);
  nose.translate(0, 0.018, 0);
  return mergeGeometries([body, nose]);
}

function geoUnknown() {
  return new THREE.SphereGeometry(0.012, 8, 6);
}

function mergeGeometries(geos: THREE.BufferGeometry[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const geo of geos) {
    // Indexed primitives reuse vertices; flatten their triangles before merging.
    const triangles = geo.index ? geo.toNonIndexed() : geo;
    const pa = triangles.getAttribute("position") as THREE.BufferAttribute;
    const na = triangles.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      positions.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      normals.push(na.getX(i), na.getY(i), na.getZ(i));
    }
    if (triangles !== geo) triangles.dispose();
    geo.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return merged;
}

const GEOMETRIES: Record<ObjectClass, THREE.BufferGeometry> = {
  payload: geoPayload(),
  debris: geoDebris(),
  rocket: geoRocket(),
  unknown: geoUnknown()
};

// -- helpers for instanced rendering --

export type InstancedGroups = Record<ObjectClass, THREE.InstancedMesh>;

export const OBJECT_CLASSES: ObjectClass[] = ["payload", "debris", "rocket", "unknown"];

/**
 * Instances are never rotated or scaled, so their matrices stay the identity
 * with a translated origin. Seeding the identity once per allocation lets the
 * per-tick loop write three floats instead of composing a full matrix.
 */
function seedIdentityMatrices(mesh: THREE.InstancedMesh) {
  const array = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < mesh.instanceMatrix.count; i += 1) {
    const base = i * 16;
    array[base] = 1;
    array[base + 5] = 1;
    array[base + 10] = 1;
    array[base + 15] = 1;
  }
}

export function createGroup(type: ObjectClass, capacity: number) {
  // Unlit, so an object reads the same on the day and night side — the classic
  // tracker look, and the per-instance colour then carries all the meaning
  // (class hue, eclipse dimming, selection).
  const mat = new THREE.MeshBasicMaterial({ color: OBJECT_CLASS_COLORS[type] });
  const mesh = new THREE.InstancedMesh(GEOMETRIES[type], mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  seedIdentityMatrices(mesh);
  return mesh;
}

export function ensureCapacity(mesh: THREE.InstancedMesh, needed: number) {
  const current = mesh.instanceMatrix.count;
  if (needed <= current) return mesh;

  const next = new THREE.InstancedMesh(
    mesh.geometry,
    (mesh.material as THREE.Material).clone(),
    Math.max(needed, current * 2)
  );
  next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  next.frustumCulled = false;
  next.count = 0;
  seedIdentityMatrices(next);
  return next;
}

// -- additive glow layer ---------------------------------------------------
//
// The instanced meshes read well up close, but at a full-globe zoom 16k
// satellites shrink to a few pixels of dark geometry. Reference trackers
// (satellitemap.space, stuffin.space) draw each object as a bright additive
// point, so a single `Points` layer carries the read-at-a-glance signal while
// the meshes keep supplying shape when the camera moves in.
//
// The glow is a custom shader rather than a canvas sprite: no texture upload,
// no DOM canvas (keeps the jsdom tests working), and the falloff is computed
// per pixel.

const GLOW_VERTEX = /* glsl */ `
  attribute vec3 color;
  uniform float uScale;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uSize * uScale / max(-view.z, 0.001), 1.5, 64.0);
    gl_Position = projectionMatrix * view;
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    if (d > 0.5) discard;
    // Bright core with a wide soft halo.
    float halo = smoothstep(0.5, 0.04, d);
    float core = smoothstep(0.30, 0.0, d);
    // A near-white core keeps the dot legible on both black space and the
    // brightly lit day side of the Earth.
    vec3 tint = mix(vColor, vec3(1.0), core * 0.45);
    gl_FragColor = vec4(tint, halo * 0.34 + core);
    #include <colorspace_fragment>
  }
`;

export type GlowLayer = {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  material: THREE.ShaderMaterial;
};

export function createGlowLayer(capacity: number): GlowLayer {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    uniforms: { uScale: { value: 400 }, uSize: { value: 0.022 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 1;
  return { points, geometry, material };
}

/** Grow the glow buffers in place; the scene graph keeps the same `Points`. */
export function ensureGlowCapacity(layer: GlowLayer, needed: number) {
  const current = layer.geometry.getAttribute("position").count;
  if (needed <= current) return;
  const next = Math.max(needed, current * 2);
  layer.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(next * 3), 3));
  layer.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(next * 3), 3));
}

export function makeRingSprite() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: tex,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending
    })
  );
  sprite.scale.set(0.1, 0.1, 1);
  sprite.visible = false;
  return sprite;
}

export function orbitalPeriodMinutes(altitudeKm: number) {
  if (!Number.isFinite(altitudeKm) || altitudeKm <= 0) return 0;
  const a = EARTH_RADIUS_KM + altitudeKm;
  return (2 * Math.PI * Math.sqrt((a * a * a) / EARTH_MU)) / 60;
}

// -- chase-camera models ---------------------------------------------------
//
// A real satellite is a few metres across: at globe scale it is far below one
// pixel, so the follow view uses a representative body per object class — the
// familiar bus + solar wings + dish for payloads, a spent stage for rocket
// bodies, an irregular shard for debris. The chase camera looks along the
// orbit tangent, so the rear of each body gets as much detail as the front.
// Lights are the scene's real sun plus the camera fill light, so the model is
// shaded like everything else.

/** Camera distance that frames each model nicely, in Earth radii. */
export const MODEL_VIEW_DISTANCE: Record<string, number> = {
  payload: 0.72,
  starlink: 0.6,
  iss: 1.1,
  debris1: 0.4,
  debris2: 0.38,
  debris3: 0.42,
  rocket: 0.68,
  unknown: 0.5
};

/**
 * Extra body attitude on top of the along-track frame (pitch, yaw, roll).
 * Spent stages and debris tumble, and a rear-on view of an axis-aligned
 * cylinder would read as a plain circle, so both classes are tilted.
 */
export const MODEL_ATTITUDE: Partial<Record<string, [number, number, number]>> = {
  rocket: [0.52, 0.16, 0.24],
  debris1: [0.85, 0.45, 0.2],
  debris2: [0.62, 0.3, 0.15],
  debris3: [0.9, 0.2, 0.7],
  iss: [0, 0.12, 0]
};

// --- Model resolution keys -------------------------------------------------
// ObjectClass is the coarse classification used for rendering groups, but the
// chase camera needs finer-grained models for well-known constellations and
// manned stations. Each resolved key maps to one build function below.

export const MODEL_KEYS = {
  genericPayload: "payload",
  starlink: "starlink",
  iss: "iss",
  debris1: "debris1",
  debris2: "debris2",
  debris3: "debris3",
  rocket: "rocket",
  unknown: "unknown"
} as const;

export type ModelKey = (typeof MODEL_KEYS)[keyof typeof MODEL_KEYS];

/**
 * Choose the detailed chase-camera model for one propagated object.
 * - Starlink: name contains "STARLINK" (NORAD range 43xxxx–49xxxx also common).
 * - Manned stations: ISS (25544), Tianhe (48274), name includes ISS/TIANHE/天宫/神舟.
 * - Debris: three distinct shard styles, picked deterministically from the id so
 *   the same fragment always renders the same way.
 * - Otherwise fall back to the object's coarse class.
 */
export function resolveModelKey(obj: PropagatedObject): ModelKey {
  const name = obj.name.toUpperCase();
  const norad = Number(obj.noradId);
  if (obj.objectType === "payload") {
    if (name.includes("STARLINK") || (norad >= 43000 && norad <= 49999)) {
      return MODEL_KEYS.starlink;
    }
    if (
      norad === 25544 || // ISS
      norad === 48274 || // Tianhe
      norad === 54216 || // Shenzhou 12
      norad === 54565 || // Shenzhou 13
      norad === 55318 || // Shenzhou 14
      norad === 56176 || // Shenzhou 15
      name.includes("ISS") ||
      name.includes("TIANHE") ||
      name.includes("神舟") ||
      name.includes("天宫") ||
      name.includes("ZARYA")
    ) {
      return MODEL_KEYS.iss;
    }
    return MODEL_KEYS.genericPayload;
  }
  if (obj.objectType === "debris") {
    // Hash id to pick a debris style deterministically.
    let hash = 0;
    for (let i = 0; i < obj.id.length; i += 1) {
      hash = (hash * 31 + obj.id.charCodeAt(i)) >>> 0;
    }
    const style = hash % 3;
    if (style === 0) return MODEL_KEYS.debris1;
    if (style === 1) return MODEL_KEYS.debris2;
    return MODEL_KEYS.debris3;
  }
  if (obj.objectType === "rocket") return MODEL_KEYS.rocket;
  return MODEL_KEYS.unknown;
}

/**
 * Solar-cell texture, built as a DataTexture so it needs no DOM canvas (the
 * scene also mounts under jsdom in tests). Cells sit on a silver busbar grid
 * with a subtle per-row sheen instead of one flat blue.
 */
function makePanelTexture() {
  const size = 256;
  const cell = 32;
  const gap = 2;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const cx = x % cell;
      const cy = y % cell;
      if (cx < gap || cy < gap) {
        data[offset] = 148;
        data[offset + 1] = 156;
        data[offset + 2] = 168;
        data[offset + 3] = 255;
        continue;
      }
      const cellX = Math.floor(x / cell);
      const cellY = Math.floor(y / cell);
      const tone = 0.78 + 0.22 * Math.sin(cellX * 1.7 + cellY * 2.3);
      const sheen = 0.6 + 0.4 * (cy / cell);
      data[offset] = 12 + 10 * tone;
      data[offset + 1] = 42 + 44 * tone;
      data[offset + 2] = 88 + 74 * tone * sheen;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Faint crinkle bump for multi-layer insulation foil. */
function makeFoilBump() {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const wave = Math.sin(x * 1.9 + y * 2.7) + Math.sin(x * 0.7 - y * 1.3);
      const value = 128 + wave * 26 + Math.random() * 18;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.needsUpdate = true;
  return texture;
}

const PANEL_TEXTURE = makePanelTexture();
const FOIL_BUMP = makeFoilBump();

const MODEL_MATERIALS = {
  // Metals need an environment map to read as metal; without one they go
  // black on the night side, so these sit low-metalness with a faint
  // self-illumination that keeps the silhouette legible in eclipse.
  gold: new THREE.MeshStandardMaterial({
    color: "#b5904f",
    metalness: 0.42,
    roughness: 0.36,
    bumpMap: FOIL_BUMP,
    bumpScale: 0.6,
    emissive: "#241a09",
    emissiveIntensity: 0.55
  }),
  silver: new THREE.MeshStandardMaterial({
    color: "#c3c9d3",
    metalness: 0.5,
    roughness: 0.34,
    emissive: "#20242b",
    emissiveIntensity: 0.45
  }),
  panel: new THREE.MeshStandardMaterial({
    color: "#ffffff",
    map: PANEL_TEXTURE,
    metalness: 0.32,
    roughness: 0.3,
    emissive: "#0d2a55",
    emissiveMap: PANEL_TEXTURE,
    emissiveIntensity: 0.9
  }),
  dish: new THREE.MeshStandardMaterial({
    color: "#cdd3dc",
    metalness: 0.45,
    roughness: 0.36,
    emissive: "#1f242c",
    emissiveIntensity: 0.45,
    side: THREE.DoubleSide
  }),
  dark: new THREE.MeshStandardMaterial({
    color: "#2a2f36",
    metalness: 0.32,
    roughness: 0.55,
    emissive: "#0c0e12",
    emissiveIntensity: 0.45
  }),
  white: new THREE.MeshStandardMaterial({
    color: "#e6e9ee",
    metalness: 0.12,
    roughness: 0.58,
    emissive: "#14171c",
    emissiveIntensity: 0.45
  }),
  debris: new THREE.MeshStandardMaterial({
    color: "#a7adb6",
    metalness: 0.45,
    roughness: 0.62,
    emissive: "#1a1e24",
    emissiveIntensity: 0.5,
    flatShading: true
  })
};

type Part = {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
};

function part({ geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0 }: Part) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  return mesh;
}

/** Thin structural member between two points (booms, struts, feed arms). */
function link(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material) {
  const direction = new THREE.Vector3().subVectors(b, a);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 8), mat);
  mesh.position.copy(a).addScaledVector(direction, 0.5);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize()
  );
  return mesh;
}

/** Parabolic dish, axis +Y, opening at the rim (rotate to aim it). */
function dishGeometry(radius: number, depth: number, segments = 24) {
  const points: THREE.Vector2[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(new THREE.Vector2(radius * t, depth * t * t));
  }
  return new THREE.LatheGeometry(points, segments);
}

/** Tangent ogive nose cone, base at y=0 and tip at y=length, axis +Y. */
function ogiveGeometry(radius: number, length: number, segments = 24) {
  const points: THREE.Vector2[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(
      new THREE.Vector2(
        Math.max(0.0004, radius * Math.sqrt(Math.max(0, 1 - t * t))),
        length * t
      )
    );
  }
  return new THREE.LatheGeometry(points, segments);
}

/** Bell nozzle, throat at y=0 and exit at y=length, axis +Y. */
function bellGeometry(throat: number, exit: number, length: number, segments = 22) {
  const points: THREE.Vector2[] = [];
  const steps = 9;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    points.push(new THREE.Vector2(throat + (exit - throat) * Math.pow(t, 1.7), length * t));
  }
  return new THREE.LatheGeometry(points, segments);
}

/** Two solar wings with aluminium rails, split panels and a hinge bar. */
function addSolarWings(group: THREE.Group, hingeOffset: number, span: number, depth: number) {
  const half = span / 2;
  for (const sign of [-1, 1]) {
    // Hinge arm bridges the bus wall and the panel root.
    group.add(
      part({
        geo: new THREE.CylinderGeometry(0.0016, 0.0016, 0.014, 8),
        mat: MODEL_MATERIALS.silver,
        x: sign * (hingeOffset + 0.007),
        rz: Math.PI / 2
      })
    );
    for (let index = 0; index < 2; index += 1) {
      const panelSpan = half - 0.0016;
      const centerX = sign * (hingeOffset + 0.014 + half * (index + 0.5));
      group.add(
        part({
          geo: new THREE.BoxGeometry(panelSpan, 0.0022, depth),
          mat: MODEL_MATERIALS.panel,
          x: centerX
        })
      );
      // Rails read as cell strings and catch the sun at grazing angles.
      for (const zSign of [-1, 1]) {
        group.add(
          part({
            geo: new THREE.BoxGeometry(panelSpan, 0.0026, 0.0016),
            mat: MODEL_MATERIALS.silver,
            x: centerX,
            z: zSign * (depth / 2 + 0.0009)
          })
        );
      }
    }
    // Junction spar and tip bar tie the two panels together.
    for (const edge of [half, span]) {
      group.add(
        part({
          geo: new THREE.BoxGeometry(0.0018, 0.003, depth + 0.003),
          mat: MODEL_MATERIALS.silver,
          x: sign * (hingeOffset + 0.014 + edge)
        })
      );
    }
  }
}

/** Comms / Earth-observation payload: gold MLI bus, nadir dish, solar wings. */
function buildPayload() {
  const group = new THREE.Group();
  // Gold thermal blanket bus with softened edges, a dark radiator deck and a
  // white equipment bay so the body reads as a real spacecraft, not a brick.
  group.add(
    part({
      geo: new RoundedBoxGeometry(0.034, 0.036, 0.052, 3, 0.0035),
      mat: MODEL_MATERIALS.gold
    })
  );
  group.add(
    part({
      geo: new RoundedBoxGeometry(0.028, 0.0022, 0.044, 2, 0.0008),
      mat: MODEL_MATERIALS.dark,
      y: 0.0184
    })
  );
  group.add(
    part({
      geo: new THREE.BoxGeometry(0.03, 0.0022, 0.046),
      mat: MODEL_MATERIALS.white,
      y: -0.0184
    })
  );
  // Side radiator and equipment boxes break up the bus silhouette.
  group.add(part({ geo: new THREE.BoxGeometry(0.0022, 0.02, 0.03), mat: MODEL_MATERIALS.white, x: 0.0174 }));
  group.add(part({ geo: new THREE.BoxGeometry(0.008, 0.006, 0.01), mat: MODEL_MATERIALS.white, x: -0.009, y: 0.021, z: -0.014 }));
  group.add(part({ geo: new THREE.BoxGeometry(0.007, 0.004, 0.007), mat: MODEL_MATERIALS.silver, x: 0.007, y: 0.0215, z: 0.012 }));

  addSolarWings(group, 0.017, 0.07, 0.04);

  // Nadir-pointing dish (local -Y): mast, parabolic reflector, feed on struts.
  group.add(part({ geo: new THREE.CylinderGeometry(0.0022, 0.0022, 0.012, 10), mat: MODEL_MATERIALS.silver, y: -0.025 }));
  const nadirDish = part({
    geo: dishGeometry(0.017, 0.006),
    mat: MODEL_MATERIALS.dish,
    y: -0.031,
    rx: Math.PI
  });
  group.add(nadirDish);
  const feed = new THREE.Vector3(0, -0.0395, 0);
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + 0.4;
    group.add(
      link(
        new THREE.Vector3(Math.cos(angle) * 0.0155, -0.0365, Math.sin(angle) * 0.0155),
        feed,
        0.0007,
        MODEL_MATERIALS.silver
      )
    );
  }
  group.add(part({ geo: new THREE.CylinderGeometry(0.0016, 0.0016, 0.005, 8), mat: MODEL_MATERIALS.dark, y: -0.041 }));
  group.add(part({ geo: new THREE.SphereGeometry(0.0018, 8, 6), mat: MODEL_MATERIALS.silver, y: -0.0435 }));

  // Zenith TT&C antenna: small dish on a short mast.
  group.add(part({ geo: new THREE.CylinderGeometry(0.0014, 0.0014, 0.01, 6), mat: MODEL_MATERIALS.silver, y: 0.023 }));
  group.add(part({ geo: dishGeometry(0.009, 0.0032, 18), mat: MODEL_MATERIALS.dish, y: 0.028 }));
  group.add(part({ geo: new THREE.SphereGeometry(0.0016, 8, 6), mat: MODEL_MATERIALS.dark, y: 0.0325 }));

  // Star tracker and a deployed boom across one corner of the bus.
  group.add(part({ geo: new THREE.CylinderGeometry(0.0032, 0.0032, 0.008, 10), mat: MODEL_MATERIALS.dark, x: 0.011, y: 0.021, z: -0.018 }));
  group.add(part({ geo: new THREE.CylinderGeometry(0.0036, 0.0036, 0.003, 10), mat: MODEL_MATERIALS.white, x: 0.011, y: 0.0245, z: -0.018 }));
  group.add(
    link(
      new THREE.Vector3(-0.017, 0.006, -0.02),
      new THREE.Vector3(-0.048, 0.016, -0.042),
      0.0012,
      MODEL_MATERIALS.silver
    )
  );
  group.add(part({ geo: new THREE.SphereGeometry(0.0022, 8, 6), mat: MODEL_MATERIALS.dark, x: -0.048, y: 0.016, z: -0.042 }));

  // Rear-facing apogee engine: a rear-on view of the bus needs a focal point.
  group.add(part({ geo: new THREE.CylinderGeometry(0.005, 0.005, 0.004, 12), mat: MODEL_MATERIALS.dark, z: -0.028 }));
  group.add(
    part({
      geo: bellGeometry(0.0032, 0.0062, 0.008),
      mat: MODEL_MATERIALS.dish,
      z: -0.03,
      rx: -Math.PI / 2
    })
  );
  // The chase camera looks straight at this face, so it gets an inset service
  // panel, a battery box and four corner thrusters instead of bare foil.
  group.add(part({ geo: new THREE.BoxGeometry(0.028, 0.03, 0.0012), mat: MODEL_MATERIALS.dark, z: -0.0262 }));
  group.add(
    part({
      geo: new THREE.BoxGeometry(0.011, 0.007, 0.0024),
      mat: MODEL_MATERIALS.silver,
      x: -0.0045,
      y: 0.0115,
      z: -0.0274
    })
  );
  for (const [tx, ty] of [
    [-0.0125, -0.0135],
    [0.0125, -0.0135],
    [-0.0125, 0.0135],
    [0.0125, 0.0135]
  ]) {
    group.add(
      part({
        geo: new THREE.CylinderGeometry(0.0022, 0.0034, 0.0034, 8),
        mat: MODEL_MATERIALS.silver,
        x: tx,
        y: ty,
        z: -0.0278,
        rx: Math.PI / 2
      })
    );
  }
  return group;
}

/** Spent upper stage: white tank, ogive nose, foil bands, bell nozzle, tanks. */
function buildRocket() {
  const group = new THREE.Group();
  // Body axis is local +Z so the stage flies nose-first along its velocity.
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.0145, 0.0145, 0.086, 24),
      mat: MODEL_MATERIALS.white,
      rx: Math.PI / 2
    })
  );
  group.add(
    part({
      geo: ogiveGeometry(0.0145, 0.03),
      mat: MODEL_MATERIALS.white,
      z: 0.043,
      rx: Math.PI / 2
    })
  );
  // Gold thermal band and dark interstage ring break up the white tube.
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.0148, 0.0148, 0.016, 24),
      mat: MODEL_MATERIALS.gold,
      z: -0.028,
      rx: Math.PI / 2
    })
  );
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.0148, 0.0148, 0.006, 24),
      mat: MODEL_MATERIALS.dark,
      z: 0.028,
      rx: Math.PI / 2
    })
  );
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.0152, 0.0152, 0.004, 24),
      mat: MODEL_MATERIALS.silver,
      z: 0.045,
      rx: Math.PI / 2
    })
  );
  // Bell nozzle, opening along -Z.
  group.add(
    part({
      geo: bellGeometry(0.0055, 0.016, 0.022),
      mat: MODEL_MATERIALS.dish,
      z: -0.043,
      rx: -Math.PI / 2
    })
  );
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.0062, 0.0062, 0.006, 16),
      mat: MODEL_MATERIALS.dark,
      z: -0.044,
      rx: Math.PI / 2
    })
  );
  // Spherical propellant tanks clustered around the rear bulkhead.
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    group.add(
      part({
        geo: new THREE.SphereGeometry(0.0058, 12, 10),
        mat: MODEL_MATERIALS.gold,
        x: Math.cos(angle) * 0.0135,
        y: Math.sin(angle) * 0.0135,
        z: -0.022
      })
    );
  }
  // Cable raceway and a pair of separation struts along the tank wall.
  group.add(part({ geo: new THREE.BoxGeometry(0.0022, 0.0022, 0.06), mat: MODEL_MATERIALS.dark, x: 0.0135, y: 0.003, z: 0.004 }));
  for (const sign of [-1, 1]) {
    group.add(part({ geo: new THREE.BoxGeometry(0.0016, 0.0016, 0.03), mat: MODEL_MATERIALS.silver, x: sign * 0.011, y: -0.009, z: 0.012 }));
  }
  return group;
}

/** Unclassified object: octagonal bus, small wing, beacon mast. */
function buildUnknown() {
  const group = new THREE.Group();
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.019, 0.019, 0.042, 8),
      mat: MODEL_MATERIALS.white
    })
  );
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.019, 0.019, 0.006, 8),
      mat: MODEL_MATERIALS.gold,
      y: -0.018
    })
  );
  group.add(
    part({
      geo: new THREE.CylinderGeometry(0.006, 0.019, 0.012, 8),
      mat: MODEL_MATERIALS.white,
      y: 0.026
    })
  );
  group.add(part({ geo: new THREE.BoxGeometry(0.005, 0.0024, 0.026), mat: MODEL_MATERIALS.silver, x: 0.024 }));
  group.add(part({ geo: new THREE.BoxGeometry(0.03, 0.0022, 0.022), mat: MODEL_MATERIALS.panel, x: 0.041 }));
  group.add(part({ geo: new THREE.CylinderGeometry(0.0014, 0.0014, 0.024, 6), mat: MODEL_MATERIALS.dark, y: 0.043 }));
  group.add(part({ geo: new THREE.SphereGeometry(0.0022, 8, 6), mat: MODEL_MATERIALS.silver, y: 0.056 }));
  return group;
}

/** Starlink broadband satellite: white body, large solar wings, phased array. */
function buildStarlink() {
  const group = new THREE.Group();
  // Body axis +Z is the direction of travel; the phased array points -Y (nadir).
  group.add(
    part({
      geo: new RoundedBoxGeometry(0.018, 0.009, 0.022, 2, 0.0015),
      mat: MODEL_MATERIALS.white
    })
  );
  // Phased array antenna — black panel on the nadir face.
  group.add(
    part({
      geo: new THREE.BoxGeometry(0.016, 0.0012, 0.018),
      mat: MODEL_MATERIALS.dark,
      y: -0.005
    })
  );
  // Small zenith antenna (top).
  group.add(part({ geo: new THREE.CylinderGeometry(0.001, 0.0014, 0.004, 6), mat: MODEL_MATERIALS.dark, y: 0.007 }));
  group.add(part({ geo: new THREE.SphereGeometry(0.0012, 8, 6), mat: MODEL_MATERIALS.silver, y: 0.009 }));

  // Deployed solar wings — two panels per side, spread to either side of the body.
  for (const sign of [-1, 1]) {
    // Hinge arm from the body wall to the panel root.
    group.add(
      part({
        geo: new THREE.CylinderGeometry(0.0014, 0.0014, 0.007, 6),
        mat: MODEL_MATERIALS.silver,
        x: sign * (0.009 + 0.0035),
        rz: Math.PI / 2
      })
    );
    // Two panels per side, unfolded to +X.
    for (let index = 0; index < 2; index += 1) {
      group.add(
        part({
          geo: new THREE.BoxGeometry(0.026, 0.0014, 0.014),
          mat: MODEL_MATERIALS.panel,
          x: sign * (0.0125 + 0.013 + index * 0.026 + 0.013),
          z: index === 0 ? 0 : 0.008
        })
      );
      // Silver rail on the panel edge.
      group.add(
        part({
          geo: new THREE.BoxGeometry(0.026, 0.0018, 0.0008),
          mat: MODEL_MATERIALS.silver,
          x: sign * (0.0125 + 0.013 + index * 0.026 + 0.013),
          z: index === 0 ? -0.0074 : 0.0154
        })
      );
    }
  }
  return group;
}

/**
 * Manned station: truss core, cylindrical modules, and large solar wings.
 * Scale is deliberately small (~10 m span → 0.008 Earth radii) so the station
 * reads as a single object in the chase frame, not a city block.
 */
function buildISS() {
  const group = new THREE.Group();
  // Main truss (white): the backbone of the station, axis +X.
  group.add(
    part({
      geo: new THREE.BoxGeometry(0.04, 0.004, 0.004),
      mat: MODEL_MATERIALS.white,
      x: -0.01
    })
  );
  // Six cylindrical modules attached to the truss: different sizes for major nodes.
  const modules = [
    { r: 0.006, l: 0.012, x: -0.025, y: 0.003, z: 0, rx: Math.PI / 2, mat: MODEL_MATERIALS.white },
    { r: 0.005, l: 0.009, x: -0.018, y: -0.003, z: 0, rx: Math.PI / 2, mat: MODEL_MATERIALS.silver },
    { r: 0.007, l: 0.014, x: -0.008, y: 0.003, z: 0, rx: Math.PI / 2, mat: MODEL_MATERIALS.white },
    { r: 0.004, l: 0.005, x: 0.002, y: -0.003, z: 0, rx: Math.PI / 2, mat: MODEL_MATERIALS.gold }
  ];
  for (const m of modules) {
    group.add(
      part({
        geo: new THREE.CylinderGeometry(m.r, m.r, m.l, 12),
        mat: m.mat,
        x: m.x,
        y: m.y,
        z: m.z,
        rx: m.rx
      })
    );
  }
  // Cupola: spherical observation module at the bottom.
  group.add(part({ geo: new THREE.SphereGeometry(0.0045, 12, 10), mat: MODEL_MATERIALS.dark, x: -0.014, y: -0.007, z: 0 }));

  // Solar trusses extending along +Y and -Y from the main truss.
  for (const sign of [-1, 1]) {
    group.add(
      part({
        geo: new THREE.BoxGeometry(0.004, 0.018, 0.003),
        mat: MODEL_MATERIALS.white,
        x: -0.01,
        y: sign * 0.01
      })
    );
    // Four solar panels per side, stacked along the truss.
    for (let i = 0; i < 4; i += 1) {
      group.add(
        part({
          geo: new THREE.BoxGeometry(0.022, 0.0012, 0.01),
          mat: MODEL_MATERIALS.panel,
          x: -0.022 + i * 0.008,
          y: sign * 0.019
        })
      );
      group.add(
        part({
          geo: new THREE.BoxGeometry(0.022, 0.0016, 0.0008),
          mat: MODEL_MATERIALS.silver,
          x: -0.022 + i * 0.008,
          y: sign * 0.013
        })
      );
    }
  }
  return group;
}

/** Debris style 1: torn solar panel, broken rod, foil chunk. */
function buildDebris1() {
  const group = new THREE.Group();
  const tornPanel = (radius: number, depth: number) => {
    const shape = new THREE.Shape();
    const points = 9;
    for (let i = 0; i < points; i += 1) {
      const angle = (i / points) * Math.PI * 2;
      const r = radius * (0.68 + Math.random() * 0.5);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r * 0.82;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 });
    geometry.center();
    return geometry;
  };
  group.add(part({ geo: tornPanel(0.022, 0.0016), mat: MODEL_MATERIALS.panel, rx: 0.55, rz: 0.3 }));
  group.add(part({ geo: tornPanel(0.016, 0.0012), mat: MODEL_MATERIALS.debris, x: 0.02, y: -0.012, z: 0.008, rx: -0.5, ry: 0.4, rz: 0.9 }));
  group.add(link(new THREE.Vector3(-0.028, -0.01, 0.004), new THREE.Vector3(0.026, 0.02, -0.012), 0.0014, MODEL_MATERIALS.silver));
  group.add(part({ geo: new THREE.DodecahedronGeometry(0.006, 0), mat: MODEL_MATERIALS.gold, x: -0.016, y: 0.014, z: -0.014, rx: 0.8 }));
  return group;
}

/** Debris style 2: broken rocket stage section, bolt, antenna stub. */
function buildDebris2() {
  const group = new THREE.Group();
  // Broken rocket tube section (white cylinder cut short).
  group.add(part({ geo: new THREE.CylinderGeometry(0.012, 0.012, 0.03, 16), mat: MODEL_MATERIALS.white, rx: Math.PI / 2, ry: 0.3 }));
  // Golden insulation band around one end.
  group.add(part({ geo: new THREE.CylinderGeometry(0.0125, 0.0125, 0.006, 16), mat: MODEL_MATERIALS.gold, z: -0.014, rx: Math.PI / 2 }));
  // Broken nozzle fragment on the end.
  group.add(part({ geo: new THREE.ConeGeometry(0.008, 0.01, 10, 1, true), mat: MODEL_MATERIALS.dish, z: -0.03, rx: Math.PI / 2, ry: 0.3 }));
  // A few loose bolts / washers.
  for (let i = 0; i < 3; i += 1) {
    group.add(
      part({
        geo: new THREE.CylinderGeometry(0.0016, 0.0016, 0.002, 6),
        mat: MODEL_MATERIALS.silver,
        x: (Math.random() - 0.5) * 0.04,
        y: (Math.random() - 0.5) * 0.01,
        z: (Math.random() - 0.5) * 0.02,
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI
      })
    );
  }
  // Antenna stub sticking out.
  group.add(part({ geo: new THREE.CylinderGeometry(0.0006, 0.0006, 0.012, 4), mat: MODEL_MATERIALS.silver, x: 0.018, y: 0.008, rz: 0.6 }));
  return group;
}

/** Debris style 3: crumpled MLI foil, electronics box, solar cell shard. */
function buildDebris3() {
  const group = new THREE.Group();
  // Crumpled foil chunk: irregular box with gold material.
  group.add(
    part({
      geo: new THREE.BoxGeometry(0.02, 0.012, 0.014),
      mat: MODEL_MATERIALS.gold,
      rx: 0.4,
      ry: 0.6
    })
  );
  // Small electronics box.
  group.add(part({ geo: new THREE.BoxGeometry(0.007, 0.004, 0.006), mat: MODEL_MATERIALS.silver, x: -0.012, y: 0.008, z: 0.01, rx: 0.3, ry: 0.2 }));
  // Solar cell shard (single cell from a panel).
  group.add(part({ geo: new THREE.BoxGeometry(0.012, 0.001, 0.009), mat: MODEL_MATERIALS.panel, x: 0.022, y: -0.006, z: -0.005, rx: -0.7, ry: 0.5, rz: 0.8 }));
  // Thin wire.
  group.add(link(new THREE.Vector3(-0.005, 0.012, 0.005), new THREE.Vector3(0.008, 0.016, -0.003), 0.0004, MODEL_MATERIALS.silver));
  return group;
}

export function createSatelliteModels(): Record<string, THREE.Group> {
  return {
    [MODEL_KEYS.genericPayload]: buildPayload(),
    [MODEL_KEYS.starlink]: buildStarlink(),
    [MODEL_KEYS.iss]: buildISS(),
    [MODEL_KEYS.debris1]: buildDebris1(),
    [MODEL_KEYS.debris2]: buildDebris2(),
    [MODEL_KEYS.debris3]: buildDebris3(),
    [MODEL_KEYS.rocket]: buildRocket(),
    [MODEL_KEYS.unknown]: buildUnknown()
  };
}

export function disposeSatelliteModels(models: Record<string, THREE.Group>) {
  // Materials and their textures are module-level singletons shared by every
  // mount (React Strict Mode mounts twice in development), so only the
  // per-build geometry is released here.
  for (const group of Object.values(models)) {
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.geometry.dispose();
    });
  }
}
