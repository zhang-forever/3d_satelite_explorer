"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CATALOGS } from "@/lib/catalogs";
import type { ObjectClass, PropagatedObject } from "@/lib/orbit";

type GlobeSceneProps = {
  objects: PropagatedObject[];
  selectedId: string | null;
  track: PropagatedObject[];
  onSelect: (id: string) => void;
  observer?: { latitudeDeg: number; longitudeDeg: number } | null;
  sceneTime: Date;
};

export type GlobeSceneHandle = {
  takeScreenshot: () => void;
};

// Local copies live under /public/textures so the app works fully offline.
// Sourced once from threejs.org/examples/textures/planets/ — see README attribution.
const EARTH_COLOR = "/textures/earth_atmos_2048.jpg";
const EARTH_NORMAL = "/textures/earth_normal_2048.jpg";
const EARTH_SPECULAR = "/textures/earth_specular_2048.jpg";
const EARTH_CLOUDS = "/textures/earth_clouds_1024.png";

const FALLBACK_PALETTE: Record<ObjectClass, string> = {
  payload: "#22d3ee",
  debris: "#ef4444",
  rocket: "#c084fc",
  unknown: "#94a3b8"
};

const GROUP_COLOR: Record<string, string> = Object.fromEntries(
  CATALOGS.map((catalog) => [catalog.id, catalog.color])
);

function colorFor(obj: PropagatedObject) {
  return GROUP_COLOR[obj.groupId] ?? FALLBACK_PALETTE[obj.objectType];
}

const SELECTED_COLOR = "#fbbf24";

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
    const pa = geo.getAttribute("position") as THREE.BufferAttribute;
    const na = geo.getAttribute("normal") as THREE.BufferAttribute;
    for (let i = 0; i < pa.count; i++) {
      positions.push(pa.getX(i), pa.getY(i), pa.getZ(i));
      normals.push(na.getX(i), na.getY(i), na.getZ(i));
    }
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

function createGroup(type: ObjectClass, capacity: number) {
  const mat = new THREE.MeshLambertMaterial({ color: FALLBACK_PALETTE[type] });
  const mesh = new THREE.InstancedMesh(GEOMETRIES[type], mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

function ensureCapacity(
  mesh: THREE.InstancedMesh,
  needed: number
): THREE.InstancedMesh {
  const max = mesh.instanceMatrix.count;
  if (needed <= max) return mesh;
  const newCap = Math.max(needed, max * 2);
  const geo = mesh.geometry;
  const mat = (mesh.material as THREE.Material).clone();
  const next = new THREE.InstancedMesh(geo, mat, newCap);
  next.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  next.frustumCulled = false;
  next.count = 0;
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

type PopupInfo = {
  x: number;
  y: number;
  name: string;
  noradId: string;
  altitudeKm: number;
  speedKmS: number;
  orbitPeriodMin: number;
  objectType: string;
};

export default forwardRef<GlobeSceneHandle, GlobeSceneProps>(function GlobeScene(
  { objects, selectedId, track, onSelect, observer, sceneTime },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    groups: InstancedGroups;
    idToIndex: Map<string, { group: ObjectClass; index: number; baseColor: string; inShadow: boolean }>;
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

  const [popup, setPopup] = useState<PopupInfo | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // -- expose screenshot via ref --
  useImperativeHandle(ref, () => ({
    takeScreenshot: () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const dataUrl = canvas.toDataURL("image/png");
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `orbital-field-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch {
        // canvas tainted or not ready
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
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#030712");

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.01, 120);
    camera.position.set(0, 2.1, 4.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
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
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.18;

    const ambient = new THREE.AmbientLight("#9db7ff", 0.65);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight("#ffffff", 2.4);
    sun.position.set(4, 2, 5);
    scene.add(sun);

    const textureLoader = new THREE.TextureLoader();

    const earthMat = new THREE.MeshPhongMaterial({
      shininess: 12,
      specular: new THREE.Color("#3a3a3a")
    });
    textureLoader.load(EARTH_COLOR, (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      earthMat.map = t;
      earthMat.needsUpdate = true;
    });
    textureLoader.load(EARTH_NORMAL, (t) => {
      earthMat.normalMap = t;
      earthMat.normalScale = new THREE.Vector2(0.8, 0.8);
      earthMat.needsUpdate = true;
    });
    textureLoader.load(EARTH_SPECULAR, (t) => {
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
    textureLoader.load(EARTH_CLOUDS, (t) => {
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
    scene.add(
      new THREE.Points(
        starsGeo,
        new THREE.PointsMaterial({
          color: "#dbeafe",
          size: 0.035,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.9
        })
      )
    );

    // instanced groups
    const INITIAL_CAP = 10000;
    const groups: InstancedGroups = {
      payload: createGroup("payload", INITIAL_CAP),
      debris: createGroup("debris", INITIAL_CAP),
      rocket: createGroup("rocket", INITIAL_CAP),
      unknown: createGroup("unknown", INITIAL_CAP)
    };
    for (const g of Object.values(groups)) scene.add(g);
    const idToIndex = new Map<string, { group: ObjectClass; index: number; baseColor: string; inShadow: boolean }>();

    // track line
    const trackGeo = new THREE.BufferGeometry();
    const trackLine = new THREE.Line(
      trackGeo,
      new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.92 })
    );
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
    footprintLine.visible = false;
    scene.add(footprintLine);

    // ground track (sub-satellite trail of selected object)
    const groundTrackGeo = new THREE.BufferGeometry();
    const groundTrackLine = new THREE.Line(
      groundTrackGeo,
      new THREE.LineBasicMaterial({ color: "#fde68a", transparent: true, opacity: 0.85 })
    );
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
    scene.add(terminatorLine);

    // raycasting
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const handlePointerDown = (event: PointerEvent) => {
      const current = sceneRef.current;
      if (!current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(Object.values(current.groups), false);
      const first = hits[0];
      if (first?.instanceId !== undefined) {
        const mesh = first.object as THREE.InstancedMesh;
        for (const [type, group] of Object.entries(current.groups) as [ObjectClass, THREE.InstancedMesh][]) {
          if (group !== mesh) continue;
          for (const [id, info] of current.idToIndex) {
            if (info.group === type && info.index === first.instanceId) {
              onSelectRef.current(id);
              // Find object info for popup
              const obj = currentObjectsRef.current.find((o) => o.id === id);
              if (obj) {
                const periodMin = obj.altitudeKm > 0
                  ? 2 * Math.PI * Math.sqrt(Math.pow(6378.137 + obj.altitudeKm, 3) / 398600.4418) / 60
                  : 0;
                setPopup({
                  x: event.clientX,
                  y: event.clientY,
                  name: obj.name,
                  noradId: obj.noradId,
                  altitudeKm: obj.altitudeKm,
                  speedKmS: obj.speedKmS,
                  orbitPeriodMin: periodMin,
                  objectType: obj.objectType
                });
                if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
                popupTimerRef.current = setTimeout(() => setPopup(null), 5000);
              }
              return;
            }
          }
        }
      }
      // Clicked empty space – dismiss popup
      setPopup(null);
    };
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resizeObserver.observe(host);

    const animate = () => {
      controls.update();
      earth.rotation.y += 0.00035;
      cloudMesh.rotation.y += 0.00055;
      atmosphere.rotation.y += 0.00025;
      renderer.render(scene, camera);
      if (sceneRef.current) {
        sceneRef.current.frame = requestAnimationFrame(animate);
      }
    };

    sceneRef.current = {
      camera,
      renderer,
      controls,
      groups,
      idToIndex,
      selectedSprite,
      trackLine,
      cloudMesh,
      observerMarker,
      footprintLine,
      groundTrackLine,
      terminatorLine,
      frame: requestAnimationFrame(animate)
    };

    canvasRef.current = renderer.domElement;

    return () => {
      const cur = sceneRef.current;
      canvasRef.current = null;
      if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      if (cur) cancelAnimationFrame(cur.frame);
      controls.dispose();
      for (const g of Object.values(groups)) {
        (g.material as THREE.Material).dispose();
      }
      trackGeo.dispose();
      footprintGeo.dispose();
      groundTrackGeo.dispose();
      terminatorGeo.dispose();
      cloudMesh.geometry.dispose();
      cloudMat.dispose();
      observerGeo.dispose();
      observerMat.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      sceneRef.current = null;
    };
  }, []);

  // ---- place instances whenever objects list changes ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;

    let { groups } = cur;
    const { idToIndex } = cur;
    idToIndex.clear();

    // count per type & ensure capacity
    const counts = { payload: 0, debris: 0, rocket: 0, unknown: 0 };
    for (const obj of objects) counts[obj.objectType]++;

    for (const type of Object.keys(groups) as ObjectClass[]) {
      const needed = counts[type];
      let mesh = groups[type];
      if (needed > mesh.instanceMatrix.count) {
        // reallocate with larger buffer
        const old = mesh;
        const next = ensureCapacity(old, needed);
        if (next !== old) {
          const oldParent = old.parent;
          old.removeFromParent();
          (old.material as THREE.Material).dispose();
          oldParent?.add(next);
          groups = { ...groups, [type]: next };
          cur.groups = groups;
        }
        mesh = next;
      }
      // eslint-disable-next-line react-hooks/immutability
      mesh.count = needed;
    }

    const dummy = new THREE.Object3D();
    const indices: Record<string, number> = { payload: 0, debris: 0, rocket: 0, unknown: 0 };
    const reusableColor = new THREE.Color();
    const selColor = new THREE.Color(SELECTED_COLOR);

    for (const obj of objects) {
      const type = obj.objectType;
      const idx = indices[type];
      const mesh = groups[type];
      if (idx >= mesh.instanceMatrix.count) continue;

      const baseHex = colorFor(obj);
      dummy.position.set(obj.scene.x, obj.scene.y, obj.scene.z);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      if (obj.id === selectedId) {
        mesh.setColorAt(idx, selColor);
      } else {
        reusableColor.set(baseHex);
        if (obj.inShadow) reusableColor.multiplyScalar(0.32);
        mesh.setColorAt(idx, reusableColor);
      }
      idToIndex.set(obj.id, { group: type, index: idx, baseColor: baseHex, inShadow: obj.inShadow });
      indices[type]++;
    }

    // hide unused slots
    dummy.scale.setScalar(0.01);
    for (const type of Object.keys(groups) as ObjectClass[]) {
      const mesh = groups[type];
      const used = indices[type];
      for (let i = used; i < mesh.count; i++) {
        dummy.position.set(0, 0, -999);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }, [objects, selectedId]);

  // -- keep a mutable ref of current objects for the click handler --
  const currentObjectsRef = useRef<PropagatedObject[]>(objects);
  useEffect(() => {
    currentObjectsRef.current = objects;
  }, [objects]);

  // ---- selection color pulse (only update colors, avoid full repopulation) ----
  const prevSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    const { groups, idToIndex } = cur;
    const selColor = new THREE.Color(SELECTED_COLOR);
    const reusableColor = new THREE.Color();

    // restore previous selection
    if (prevSelectedRef.current && prevSelectedRef.current !== selectedId) {
      const prev = idToIndex.get(prevSelectedRef.current);
      if (prev) {
        reusableColor.set(prev.baseColor);
        if (prev.inShadow) reusableColor.multiplyScalar(0.32);
        groups[prev.group].setColorAt(prev.index, reusableColor);
      }
    }
    // apply new selection
    if (selectedId) {
      const info = idToIndex.get(selectedId);
      if (info) groups[info.group].setColorAt(info.index, selColor);
    }
    prevSelectedRef.current = selectedId;

    for (const g of Object.values(groups)) {
      if (g.instanceColor) g.instanceColor.needsUpdate = true;
    }
  }, [selectedId, objects, sceneRef]);

  // ---- track line ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    if (!track.length) {
      cur.trackLine.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(), 3));
      cur.trackLine.visible = false;
      return;
    }
    const positions = new Float32Array(track.length * 3);
    track.forEach((p, i) => {
      positions[i * 3] = p.scene.x;
      positions[i * 3 + 1] = p.scene.y;
      positions[i * 3 + 2] = p.scene.z;
    });
    cur.trackLine.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    cur.trackLine.geometry.computeBoundingSphere();
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
  }, [selectedObject]);

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
    const R = 6378.137;
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
      const d = cx * 1 + cy * 0 + cz * 0;
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
    cur.footprintLine.geometry.computeBoundingSphere();
    cur.footprintLine.visible = true;
  }, [selectedObject]);

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
    cur.groundTrackLine.geometry.computeBoundingSphere();
    cur.groundTrackLine.visible = true;
  }, [track]);

  // ---- day/night terminator ----
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    // Sun subsolar point in lat/lon (approx). Compute from sun ECI direction
    // and Greenwich Mean Sidereal Time.
    const date = sceneTime;
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const Ldeg = (280.46 + 0.9856474 * n) % 360;
    const gdeg = (357.528 + 0.9856003 * n) % 360;
    const lambdaDeg =
      Ldeg + 1.915 * Math.sin((gdeg * Math.PI) / 180) + 0.02 * Math.sin((2 * gdeg * Math.PI) / 180);
    const epsilonDeg = 23.439 - 0.0000004 * n;
    const lambda = (lambdaDeg * Math.PI) / 180;
    const epsilon = (epsilonDeg * Math.PI) / 180;
    const sx = Math.cos(lambda);
    const sy = Math.cos(epsilon) * Math.sin(lambda);
    const sz = Math.sin(epsilon) * Math.sin(lambda);
    // GMST (radians)
    const T = n / 36525;
    let gmstSec = 67310.54841 +
      (876600 * 3600 + 8640184.812866) * T +
      0.093104 * T * T -
      6.2e-6 * T * T * T;
    gmstSec = ((gmstSec % 86400) + 86400) % 86400;
    const gmst = (gmstSec / 240) * (Math.PI / 180);
    // Rotate sun ECI → ECF by -gmst about Z
    const cg = Math.cos(-gmst);
    const sg = Math.sin(-gmst);
    const ex = cg * sx - sg * sy;
    const ey = sg * sx + cg * sy;
    const ez = sz;
    // Subsolar lat/lon in our scene convention: scene = (cos(lat)cos(lon), sin(lat), -cos(lat)sin(lon))
    // ECF: (cos(lat)cos(lon), cos(lat)sin(lon), sin(lat))
    // Map ECF → scene basis: scene_x = ecf_x, scene_y = ecf_z, scene_z = -ecf_y
    const cx = ex;
    const cy = ez;
    const cz = -ey;
    // Build orthonormal basis around sun-direction's antipodal axis (terminator is great circle perpendicular to sun)
    let ux = 0, uy = 1, uz = 0;
    const refDot = cx * ux + cy * uy + cz * uz;
    ux -= refDot * cx; uy -= refDot * cy; uz -= refDot * cz;
    let uLen = Math.hypot(ux, uy, uz);
    if (uLen < 1e-6) {
      ux = 1; uy = 0; uz = 0;
      const d = cx;
      ux -= d * cx; uy -= d * cy; uz -= d * cz;
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
      const x = ct * ux + st * vx;
      const y = ct * uy + st * vy;
      const z = ct * uz + st * vz;
      positions.setXYZ(i, x * r, y * r, z * r);
    }
    positions.needsUpdate = true;
    cur.terminatorLine.geometry.computeBoundingSphere();
  }, [sceneTime]);

  return (
    <div className="globe-shell" data-testid="globe-scene">
      <div ref={hostRef} className="globe-canvas" />
      <div className="scene-vignette" />
      {popup ? (
        <div
          className="sat-popup"
          style={{ left: popup.x, top: popup.y }}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="sat-popup-header">{popup.name}</div>
          <div className="sat-popup-row">
            <span>NORAD ID</span>
            <strong>{popup.noradId}</strong>
          </div>
          <div className="sat-popup-row">
            <span>Class</span>
            <strong>{popup.objectType}</strong>
          </div>
          <div className="sat-popup-row">
            <span>Altitude</span>
            <strong>{popup.altitudeKm.toFixed(1)} km</strong>
          </div>
          <div className="sat-popup-row">
            <span>Speed</span>
            <strong>{popup.speedKmS.toFixed(3)} km/s</strong>
          </div>
          <div className="sat-popup-row">
            <span>Period</span>
            <strong>{popup.orbitPeriodMin.toFixed(1)} min</strong>
          </div>
        </div>
      ) : null}
    </div>
  );
});