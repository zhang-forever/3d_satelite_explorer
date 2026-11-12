/**
 * Per-object rendering helpers for the globe: instanced geometry factories,
 * capacity management, and the per-catalog color lookup. Kept out of
 * `GlobeScene` so that file only owns the scene lifecycle.
 */
import * as THREE from "three";

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
  const mat = new THREE.MeshLambertMaterial({ color: OBJECT_CLASS_COLORS[type] });
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
