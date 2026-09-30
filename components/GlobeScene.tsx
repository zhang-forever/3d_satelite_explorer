"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CATALOGS } from "@/lib/catalogs";
import { publicAssetUrl } from "@/lib/dataAccess";
import {
  OBJECT_CLASS_COLORS,
  sunDirectionEci,
  type ObjectClass,
  type PropagatedObject
} from "@/lib/orbit";

type GlobeSceneProps = {
  objects: PropagatedObject[];
  selectedId: string | null;
  track: PropagatedObject[];
  onSelect: (id: string) => void;
  observer?: { latitudeDeg: number; longitudeDeg: number } | null;
  sceneTime: Date;
  autoRotate?: boolean;
};

export type GlobeSceneHandle = {
  takeScreenshot: () => void;
};

// Local copies live under /public/textures so the app works fully offline.
// Sourced once from threejs.org/examples/textures/planets/ — see README attribution.
const EARTH_COLOR = publicAssetUrl("/textures/earth_atmos_2048.jpg");
const EARTH_NORMAL = publicAssetUrl("/textures/earth_normal_2048.jpg");
const EARTH_SPECULAR = publicAssetUrl("/textures/earth_specular_2048.jpg");
const EARTH_CLOUDS = publicAssetUrl("/textures/earth_clouds_1024.png");

const GROUP_COLOR: Record<string, string> = Object.fromEntries(
  CATALOGS.map((catalog) => [catalog.id, catalog.color])
);

function colorFor(obj: PropagatedObject) {
  return GROUP_COLOR[obj.groupId] ?? OBJECT_CLASS_COLORS[obj.objectType];
}

const SELECTED_COLOR = "#fbbf24";
const SHADOW_DIM = 0.32;
const EARTH_MU = 398600.4418;
const EARTH_RADIUS_KM = 6378.137;

/** Capacity is grown on demand — no point reserving 10k instances per class. */
const INITIAL_CAPACITY = 1024;
const CLICK_SLOP_PX = 5;

type InstancedIndexEntry = {
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

type InstancedGroups = Record<ObjectClass, THREE.InstancedMesh>;

const OBJECT_CLASSES: ObjectClass[] = ["payload", "debris", "rocket", "unknown"];

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

function createGroup(type: ObjectClass, capacity: number) {
  const mat = new THREE.MeshLambertMaterial({ color: OBJECT_CLASS_COLORS[type] });
  const mesh = new THREE.InstancedMesh(GEOMETRIES[type], mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  seedIdentityMatrices(mesh);
  return mesh;
}

function ensureCapacity(mesh: THREE.InstancedMesh, needed: number) {
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

function makeRingSprite() {
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

function orbitalPeriodMinutes(altitudeKm: number) {
  if (!Number.isFinite(altitudeKm) || altitudeKm <= 0) return 0;
  const a = EARTH_RADIUS_KM + altitudeKm;
  return (2 * Math.PI * Math.sqrt((a * a * a) / EARTH_MU)) / 60;
}

export default forwardRef<GlobeSceneHandle, GlobeSceneProps>(function GlobeScene(
  { objects, selectedId, track, onSelect, observer, sceneTime, autoRotate = true },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    groups: InstancedGroups;
    idToIndex: Map<string, InstancedIndexEntry>;
    /** Reverse of `idToIndex`: instance id per class, for O(1) picking. */
    pickIds: Record<ObjectClass, string[]>;
    selectedSprite: THREE.Sprite;
    trackLine: THREE.Line;
    cloudMesh: THREE.Mesh;
    observerMarker: THREE.Mesh;
    footprintLine: THREE.LineLoop;
    groundTrackLine: THREE.Line;
    terminatorLine: THREE.LineLoop;
    frame: number;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // `popupId` is the only popup state kept in React — the displayed values are
  // read from the live object so they keep ticking while the popup is open.
  const [popupId, setPopupId] = useState<string | null>(null);
  const popupIdRef = useRef<string | null>(null);
  const popupElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    popupIdRef.current = popupId;
  }, [popupId]);

  const popupObject = useMemo(
    () => (popupId ? objects.find((obj) => obj.id === popupId) ?? null : null),
    [objects, popupId]
  );

  // -- expose screenshot via ref --
  useImperativeHandle(ref, () => ({
    takeScreenshot: () => {
      const current = sceneRef.current;
      if (!current) return;
      // `preserveDrawingBuffer` is off (it costs a full extra copy every
      // frame); rendering right before reading keeps the buffer valid.
      current.renderer.render(current.scene, current.camera);
      try {
        const dataUrl = current.renderer.domElement.toDataURL("image/png");
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `orbital-field-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch {
        // canvas not ready
      }
    }
  }));

  const selectedObject = useMemo(
    () => objects.find((obj) => obj.id === selectedId) ?? null,
    [objects, selectedId]
  );

  // ---- one-time scene init ----
  useEffect(() => {
    if (!hostRef.current || sceneRef.current) return;

    const host = hostRef.current;
    let disposed = false;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#030712");

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.01, 120);
    camera.position.set(0, 2.1, 4.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 1.35;
    controls.maxDistance = 14;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.18;

    const ambient = new THREE.AmbientLight("#9db7ff", 0.65);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight("#ffffff", 2.4);
    sun.position.set(4, 2, 5);
    scene.add(sun);

    const textureLoader = new THREE.TextureLoader();
    const textures: THREE.Texture[] = [];
    const loadTexture = (url: string, onLoad: (texture: THREE.Texture) => void) => {
      textures.push(textureLoader.load(url, (texture) => {
        if (disposed) {
          texture.dispose();
          return;
        }
        onLoad(texture);
      }));
    };

    const earthMat = new THREE.MeshPhongMaterial({
      shininess: 12,
      specular: new THREE.Color("#3a3a3a")
    });
    loadTexture(EARTH_COLOR, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      earthMat.map = t;
      earthMat.needsUpdate = true;
    });
    loadTexture(EARTH_NORMAL, (t) => {
      earthMat.normalMap = t;
      earthMat.normalScale = new THREE.Vector2(0.8, 0.8);
      earthMat.needsUpdate = true;
    });
    loadTexture(EARTH_SPECULAR, (t) => {
      earthMat.specularMap = t;
      earthMat.needsUpdate = true;
    });

    const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 96), earthMat);
    scene.add(earth);

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.035, 96, 96),
      new THREE.MeshBasicMaterial({
        color: "#7dd3fc",
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false
      })
    );
    scene.add(atmosphere);

    const cloudMat = new THREE.MeshPhongMaterial({
      map: null,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      depthWrite: false
    });
    const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.012, 96, 96), cloudMat);
    scene.add(cloudMesh);
    loadTexture(EARTH_CLOUDS, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      cloudMat.map = t;
      cloudMat.needsUpdate = true;
    });

    // stars
    const starsGeo = new THREE.BufferGeometry();
    const starPositions = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const r = 35 + Math.random() * 35;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      starPositions[i * 3 + 1] = r * Math.cos(phi);
      starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    starsGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starsMat = new THREE.PointsMaterial({
      color: "#dbeafe",
      size: 0.035,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9
    });
    scene.add(new THREE.Points(starsGeo, starsMat));

    // instanced groups
    const groups: InstancedGroups = {
      payload: createGroup("payload", INITIAL_CAPACITY),
      debris: createGroup("debris", INITIAL_CAPACITY),
      rocket: createGroup("rocket", INITIAL_CAPACITY),
      unknown: createGroup("unknown", INITIAL_CAPACITY)
    };
    for (const g of Object.values(groups)) scene.add(g);

    const idToIndex = new Map<string, InstancedIndexEntry>();
    const pickIds: Record<ObjectClass, string[]> = {
      payload: [],
      debris: [],
      rocket: [],
      unknown: []
    };

    // track line
    const trackGeo = new THREE.BufferGeometry();
    const trackLine = new THREE.Line(
      trackGeo,
      new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.92 })
    );
    trackLine.frustumCulled = false;
    scene.add(trackLine);

    // selection sprite
    const selectedSprite = makeRingSprite();
    scene.add(selectedSprite);

    // observer marker
    const observerGeo = new THREE.SphereGeometry(0.012, 12, 12);
    const observerMat = new THREE.MeshBasicMaterial({ color: "#86efac", depthTest: false });
    const observerMarker = new THREE.Mesh(observerGeo, observerMat);
    observerMarker.renderOrder = 2;
    observerMarker.visible = false;
    scene.add(observerMarker);

    // footprint ring (selected satellite ground coverage)
    const footprintSegments = 96;
    const footprintGeo = new THREE.BufferGeometry();
    footprintGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array((footprintSegments + 1) * 3), 3)
    );
    const footprintLine = new THREE.LineLoop(
      footprintGeo,
      new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.7 })
    );
    footprintLine.frustumCulled = false;
    footprintLine.visible = false;
    scene.add(footprintLine);

    // ground track (sub-satellite trail of selected object)
    const groundTrackGeo = new THREE.BufferGeometry();
    const groundTrackLine = new THREE.Line(
      groundTrackGeo,
      new THREE.LineBasicMaterial({ color: "#fde68a", transparent: true, opacity: 0.85 })
    );
    groundTrackLine.frustumCulled = false;
    groundTrackLine.visible = false;
    scene.add(groundTrackLine);

    // day/night terminator (great circle perpendicular to sun direction)
    const terminatorSegments = 180;
    const terminatorGeo = new THREE.BufferGeometry();
    terminatorGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(terminatorSegments * 3), 3)
    );
    const terminatorLine = new THREE.LineLoop(
      terminatorGeo,
      new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.45 })
    );
    terminatorLine.frustumCulled = false;
    scene.add(terminatorLine);

    // -- picking: press/release pair so orbiting the globe does not select --
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pressedAt: { x: number; y: number } | null = null;

    const pickAt = (clientX: number, clientY: number) => {
      const current = sceneRef.current;
      if (!current) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(Object.values(current.groups), false);
      const first = hits[0];
      if (first?.instanceId === undefined) return null;
      const type = (Object.entries(current.groups) as [ObjectClass, THREE.InstancedMesh][]).find(
        ([, mesh]) => mesh === first.object
      )?.[0];
      if (!type) return null;
      const id = current.pickIds[type][first.instanceId];
      if (!id) return null;
      return current.idToIndex.get(id)?.object ?? null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    };

    const handlePointerUp = (event: PointerEvent) => {
      const start = pressedAt;
      pressedAt = null;
      if (!start) return;
      // A drag is a camera move, not a selection.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;

      const object = pickAt(event.clientX, event.clientY);
      if (object) {
        onSelectRef.current(object.id);
        setPopupId(object.id);
        return;
      }
      // Clicked empty space — dismiss the popup.
      setPopupId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopupId(null);
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("keydown", handleKeyDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resizeObserver.observe(host);

    // Scratch objects reused every frame — no allocation inside the loop.
    const projected = new THREE.Vector3();

    const animate = () => {
      controls.update();
      earth.rotation.y += 0.00035;
      cloudMesh.rotation.y += 0.00055;
      atmosphere.rotation.y += 0.00025;

      // Keep the info popup glued to its object.
      const popupElement = popupElementRef.current;
      const activePopupId = popupIdRef.current;
      if (popupElement && activePopupId) {
        const entry = idToIndex.get(activePopupId);
        if (entry) {
          projected.set(entry.object.scene.x, entry.object.scene.y, entry.object.scene.z);
          projected.project(camera);
          const rect = renderer.domElement.getBoundingClientRect();
          const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
          const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
          popupElement.style.transform = `translate(${x}px, ${y}px)`;
          popupElement.style.visibility = projected.z > 1 ? "hidden" : "visible";
        }
      }

      renderer.render(scene, camera);
      if (sceneRef.current) {
        sceneRef.current.frame = requestAnimationFrame(animate);
      }
    };

    sceneRef.current = {
      scene,
      camera,
      renderer,
      controls,
      groups,
      idToIndex,
      pickIds,
      selectedSprite,
      trackLine,
      cloudMesh,
      observerMarker,
      footprintLine,
      groundTrackLine,
      terminatorLine,
      frame: requestAnimationFrame(animate)
    };

    return () => {
      disposed = true;
      const cur = sceneRef.current;
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("keydown", handleKeyDown);
      if (cur) cancelAnimationFrame(cur.frame);
      controls.dispose();
      earthMat.dispose();
      earth.geometry.dispose();
      atmosphere.geometry.dispose();
      (atmosphere.material as THREE.Material).dispose();
      for (const g of Object.values(cur?.groups ?? groups)) {
        (g.material as THREE.Material).dispose();
        g.dispose();
      }
      for (const texture of textures) texture.dispose();
      for (const line of [trackLine, footprintLine, groundTrackLine, terminatorLine]) {
        (line.material as THREE.Material).dispose();
      }
      trackGeo.dispose();
      footprintGeo.dispose();
      groundTrackGeo.dispose();
      terminatorGeo.dispose();
      starsGeo.dispose();
      starsMat.dispose();
      cloudMesh.geometry.dispose();
      cloudMat.dispose();
      observerGeo.dispose();
      observerMat.dispose();
      (selectedSprite.material as THREE.SpriteMaterial).map?.dispose();
      (selectedSprite.material as THREE.SpriteMaterial).dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
    // `autoRotate` is applied by its own effect below; the scene is built once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- auto-rotate toggle ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    cur.controls.autoRotate = autoRotate;
  }, [autoRotate]);

  // ---- place instances whenever the object list changes ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;

    let { groups } = cur;
    const { idToIndex, pickIds } = cur;
    idToIndex.clear();
    for (const type of OBJECT_CLASSES) pickIds[type].length = 0;

    // count per type & ensure capacity
    const counts: Record<ObjectClass, number> = { payload: 0, debris: 0, rocket: 0, unknown: 0 };
    for (const obj of objects) counts[obj.objectType] += 1;

    for (const type of OBJECT_CLASSES) {
      const needed = counts[type];
      let mesh = groups[type];
      if (needed > mesh.instanceMatrix.count) {
        const old = mesh;
        const next = ensureCapacity(old, needed);
        if (next !== old) {
          const parent = old.parent;
          old.removeFromParent();
          (old.material as THREE.Material).dispose();
          old.dispose();
          parent?.add(next);
          groups = { ...groups, [type]: next };
          cur.groups = groups;
        }
        mesh = next;
      }
      mesh.count = needed;
    }

    const reusableColor = new THREE.Color();
    const selectedColor = new THREE.Color(SELECTED_COLOR);

    for (const obj of objects) {
      const type = obj.objectType;
      const mesh = groups[type];
      // `pickIds[type].length` doubles as the next instance slot.
      const index = pickIds[type].length;
      if (index >= mesh.instanceMatrix.count) continue;

      // Position only: the identity part of the matrix was seeded once when the
      // buffer was allocated, so three floats per instance are enough.
      const array = mesh.instanceMatrix.array as Float32Array;
      const base = index * 16;
      array[base + 12] = obj.scene.x;
      array[base + 13] = obj.scene.y;
      array[base + 14] = obj.scene.z;

      const baseHex = colorFor(obj);
      if (obj.id === selectedId) {
        mesh.setColorAt(index, selectedColor);
      } else {
        reusableColor.set(baseHex);
        if (obj.inShadow) reusableColor.multiplyScalar(SHADOW_DIM);
        mesh.setColorAt(index, reusableColor);
      }

      pickIds[type][index] = obj.id;
      idToIndex.set(obj.id, {
        group: type,
        index,
        baseColor: baseHex,
        inShadow: obj.inShadow,
        object: obj
      });
    }

    for (const type of OBJECT_CLASSES) {
      const mesh = groups[type];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [objects, selectedId]);

  // ---- selection highlight (patches instance colours in place) ----
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    const { groups, idToIndex } = cur;
    const selectedColor = new THREE.Color(SELECTED_COLOR);
    const reusableColor = new THREE.Color();

    if (prevSelectedRef.current && prevSelectedRef.current !== selectedId) {
      const prev = idToIndex.get(prevSelectedRef.current);
      if (prev) {
        reusableColor.set(prev.baseColor);
        if (prev.inShadow) reusableColor.multiplyScalar(SHADOW_DIM);
        groups[prev.group].setColorAt(prev.index, reusableColor);
      }
    }
    if (selectedId) {
      const info = idToIndex.get(selectedId);
      if (info) groups[info.group].setColorAt(info.index, selectedColor);
    }
    prevSelectedRef.current = selectedId;

    for (const type of OBJECT_CLASSES) {
      const mesh = groups[type];
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [selectedId, objects]);

  // ---- track line ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!track.length) {
      cur.trackLine.visible = false;
      return;
    }
    const positions = new Float32Array(track.length * 3);
    for (let i = 0; i < track.length; i += 1) {
      const point = track[i].scene;
      positions[i * 3] = point.x;
      positions[i * 3 + 1] = point.y;
      positions[i * 3 + 2] = point.z;
    }
    cur.trackLine.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    cur.trackLine.visible = true;
  }, [track]);

  // ---- selected sprite ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!selectedObject) {
      cur.selectedSprite.visible = false;
      return;
    }
    cur.selectedSprite.position.set(
      selectedObject.scene.x,
      selectedObject.scene.y,
      selectedObject.scene.z
    );
    cur.selectedSprite.visible = true;
  }, [selectedObject, objects]);

  // ---- observer marker ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!observer || !Number.isFinite(observer.latitudeDeg) || !Number.isFinite(observer.longitudeDeg)) {
      cur.observerMarker.visible = false;
      return;
    }
    const lat = (observer.latitudeDeg * Math.PI) / 180;
    const lon = (observer.longitudeDeg * Math.PI) / 180;
    const r = 1.005;
    cur.observerMarker.position.set(
      r * Math.cos(lat) * Math.cos(lon),
      r * Math.sin(lat),
      -r * Math.cos(lat) * Math.sin(lon)
    );
    cur.observerMarker.visible = true;
  }, [observer]);

  // ---- footprint coverage circle ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!selectedObject || !Number.isFinite(selectedObject.altitudeKm)) {
      cur.footprintLine.visible = false;
      return;
    }
    const R = EARTH_RADIUS_KM;
    const h = Math.max(selectedObject.altitudeKm, 1);
    const halfAngle = Math.acos(R / (R + h));
    const lat = (selectedObject.latitude * Math.PI) / 180;
    const lon = (selectedObject.longitude * Math.PI) / 180;
    const cx = Math.cos(lat) * Math.cos(lon);
    const cy = Math.sin(lat);
    const cz = -Math.cos(lat) * Math.sin(lon);
    // pick any vector not parallel to center
    const refX = 0, refY = 1, refZ = 0;
    const refDot = cx * refX + cy * refY + cz * refZ;
    let ux = refX - refDot * cx;
    let uy = refY - refDot * cy;
    let uz = refZ - refDot * cz;
    let uLen = Math.hypot(ux, uy, uz);
    if (uLen < 1e-6) {
      ux = 1; uy = 0; uz = 0;
      const d = cx;
      ux -= d * cx; uy -= d * cy; uz -= d * cz;
      uLen = Math.hypot(ux, uy, uz);
    }
    ux /= uLen; uy /= uLen; uz /= uLen;
    // v = c × u
    const vx = cy * uz - cz * uy;
    const vy = cz * ux - cx * uz;
    const vz = cx * uy - cy * ux;
    const r = 1.003;
    const sinA = Math.sin(halfAngle);
    const cosA = Math.cos(halfAngle);
    const segments = 96;
    const positions = cur.footprintLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const x = cosA * cx + sinA * (ct * ux + st * vx);
      const y = cosA * cy + sinA * (ct * uy + st * vy);
      const z = cosA * cz + sinA * (ct * uz + st * vz);
      positions.setXYZ(i, x * r, y * r, z * r);
    }
    positions.needsUpdate = true;
    cur.footprintLine.visible = true;
  }, [selectedObject, objects]);

  // ---- ground track (sub-satellite trail) ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!track.length) {
      cur.groundTrackLine.visible = false;
      return;
    }
    const r = 1.004;
    const positions = new Float32Array(track.length * 3);
    for (let i = 0; i < track.length; i++) {
      const p = track[i];
      const lat = (p.latitude * Math.PI) / 180;
      const lon = (p.longitude * Math.PI) / 180;
      positions[i * 3] = r * Math.cos(lat) * Math.cos(lon);
      positions[i * 3 + 1] = r * Math.sin(lat);
      positions[i * 3 + 2] = -r * Math.cos(lat) * Math.sin(lon);
    }
    cur.groundTrackLine.geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3)
    );
    cur.groundTrackLine.visible = true;
  }, [track]);

  // ---- day/night terminator ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    // Sun direction in ECI, rotated into the scene's Earth-fixed basis.
    const sunEci = sunDirectionEci(sceneTime);
    const jd = sceneTime.getTime() / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    let gmstSec =
      67310.54841 +
      (876600 * 3600 + 8640184.812866) * T +
      0.093104 * T * T -
      6.2e-6 * T * T * T;
    gmstSec = ((gmstSec % 86400) + 86400) % 86400;
    const gmst = (gmstSec / 240) * (Math.PI / 180);

    const cg = Math.cos(-gmst);
    const sg = Math.sin(-gmst);
    const ex = cg * sunEci.x - sg * sunEci.y;
    const ey = sg * sunEci.x + cg * sunEci.y;
    const ez = sunEci.z;
    // ECF → scene basis: scene = (x, z, -y)
    const cx = ex;
    const cy = ez;
    const cz = -ey;

    // Orthonormal basis of the great circle perpendicular to the sun.
    let ux = 0, uy = 1, uz = 0;
    const refDot = cx * ux + cy * uy + cz * uz;
    ux -= refDot * cx; uy -= refDot * cy; uz -= refDot * cz;
    let uLen = Math.hypot(ux, uy, uz);
    if (uLen < 1e-6) {
      ux = 1; uy = 0; uz = 0;
      ux -= cx * cx; uy -= cx * cy; uz -= cx * cz;
      uLen = Math.hypot(ux, uy, uz);
    }
    ux /= uLen; uy /= uLen; uz /= uLen;
    const vx = cy * uz - cz * uy;
    const vy = cz * ux - cx * uz;
    const vz = cx * uy - cy * ux;
    const r = 1.006;
    const segments = 180;
    const positions = cur.terminatorLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      positions.setXYZ(
        i,
        (ct * ux + st * vx) * r,
        (ct * uy + st * vy) * r,
        (ct * uz + st * vz) * r
      );
    }
    positions.needsUpdate = true;
  }, [sceneTime]);

  return (
    <div className="globe-shell" data-testid="globe-scene">
      <div ref={hostRef} className="globe-canvas" />
      <div className="scene-vignette" />
      {popupObject ? (
        <div
          ref={popupElementRef}
          className="sat-popup"
          role="tooltip"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="sat-popup-card">
            <div className="sat-popup-header">{popupObject.name}</div>
            <div className="sat-popup-row">
              <span>NORAD ID</span>
              <strong>{popupObject.noradId}</strong>
            </div>
            <div className="sat-popup-row">
              <span>Class</span>
              <strong>{popupObject.objectType}</strong>
            </div>
            <div className="sat-popup-row">
              <span>Altitude</span>
              <strong>{popupObject.altitudeKm.toFixed(1)} km</strong>
            </div>
            <div className="sat-popup-row">
              <span>Speed</span>
              <strong>{popupObject.speedKmS.toFixed(3)} km/s</strong>
            </div>
            <div className="sat-popup-row">
              <span>Period</span>
              <strong>{orbitalPeriodMinutes(popupObject.altitudeKm).toFixed(1)} min</strong>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
});
