"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { publicAssetUrl } from "@/lib/dataAccess";
import {
  sunDirectionEci,
  type ObjectClass,
  type PropagatedObject
} from "@/lib/orbit";
import {
  CLICK_SLOP_PX,
  EARTH_RADIUS_KM,
  INITIAL_CAPACITY,
  MODEL_ATTITUDE,
  MODEL_VIEW_DISTANCE,
  OBJECT_CLASSES,
  SELECTED_COLOR,
  SHADOW_DIM,
  colorFor,
  createGlowLayer,
  createGroup,
  createSatelliteModels,
  disposeSatelliteModels,
  ensureCapacity,
  ensureGlowCapacity,
  makeRingSprite,
  orbitalPeriodMinutes,
  resolveModelKey,
  type GlowLayer,
  type InstancedGroups,
  type InstancedIndexEntry
} from "./GlobeObjects";

/** Pointer distance, in CSS pixels, that still counts as "on" an object. */
const HOVER_RADIUS_PX = 13;
/** Re-running the nearest-object scan more often than this is wasted work. */
const HOVER_THROTTLE_MS = 45;
/**
 * Chase camera pitch above the orbit plane, in radians. The camera still sits
 * behind the body along the direction of travel, but it is lifted enough to
 * look down at the ground: at a bare tangent the coverage footprint collapses
 * onto the horizon line and cannot be read.
 */
const FOLLOW_ELEVATION = 0.7;

export type GlobePopupLabels = {
  classification: string;
  altitude: string;
  speed: string;
  period: string;
};

const DEFAULT_POPUP_LABELS: GlobePopupLabels = {
  classification: "Class",
  altitude: "Altitude",
  speed: "Speed",
  period: "Period"
};

export type GlobeFollowLabels = {
  following: string;
  exit: string;
};

const DEFAULT_FOLLOW_LABELS: GlobeFollowLabels = {
  following: "Following",
  exit: "Exit"
};

type GlobeSceneProps = {
  objects: PropagatedObject[];
  selectedId: string | null;
  track: PropagatedObject[];
  onSelect: (id: string) => void;
  observer?: { latitudeDeg: number; longitudeDeg: number } | null;
  sceneTime: Date;
  autoRotate?: boolean;
  /** Localized labels for the click popup; defaults to English. */
  popupLabels?: GlobePopupLabels;
  /** Localized labels for the chase-camera badge. */
  followLabels?: GlobeFollowLabels;
  classLabel?: (type: ObjectClass) => string;
};

export type GlobeSceneHandle = {
  takeScreenshot: () => void;
  /** Ease the camera onto one object, keeping the Earth in frame. */
  focus: (id: string) => void;
  /** Return to the opening overview shot (also leaves the chase view). */
  home: () => void;
};

// Local copies live under /public/textures so the app works fully offline.
// Sourced once from threejs.org/examples/textures/planets/ — see README attribution.
const EARTH_COLOR = publicAssetUrl("/textures/earth_atmos_2048.jpg");
const EARTH_NORMAL = publicAssetUrl("/textures/earth_normal_2048.jpg");
const EARTH_SPECULAR = publicAssetUrl("/textures/earth_specular_2048.jpg");
const EARTH_CLOUDS = publicAssetUrl("/textures/earth_clouds_1024.png");

/**
 * Latitude/longitude wireframe for the globe. Built as explicit segments so
 * the result is a clean graticule rather than a triangulated wireframe.
 */
function createGraticule(radius: number, latStep = 15, lonStep = 15, curveStep = 4) {
  const points: number[] = [];
  const push = (latA: number, lonA: number, latB: number, lonB: number) => {
    for (const [lat, lon] of [[latA, lonA], [latB, lonB]]) {
      const phi = (lat * Math.PI) / 180;
      const theta = (lon * Math.PI) / 180;
      points.push(
        radius * Math.cos(phi) * Math.cos(theta),
        radius * Math.sin(phi),
        -radius * Math.cos(phi) * Math.sin(theta)
      );
    }
  };

  for (let lat = -90 + latStep; lat < 90; lat += latStep) {
    for (let lon = -180; lon < 180; lon += curveStep) {
      push(lat, lon, lat, lon + curveStep);
    }
  }
  for (let lon = -180; lon < 180; lon += lonStep) {
    for (let lat = -90; lat < 90; lat += curveStep) {
      push(lat, lon, lat + curveStep, lon);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({
    color: "#6d8ba8",
    transparent: true,
    opacity: 0.1,
    depthWrite: false
  });
  return new THREE.LineSegments(geometry, material);
}

/**
 * Sun direction in the scene's Earth-fixed basis (the frame the satellite
 * positions and the observer marker use). Lighting the globe from this vector
 * keeps the lit hemisphere, the terminator and the per-object eclipse shading
 * consistent with each other — previously the key light sat at a fixed spot
 * while the terminator was drawn from the real sun.
 */
function sunDirectionScene(sceneTime: Date) {
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
  return new THREE.Vector3(ex, ez, -ey).normalize();
}

type FollowState = {
  id: string;
  /** Smoothed object position: propagation updates at 1 Hz, the camera does not. */
  smooth: THREE.Vector3;
  /** Entry move, from the current view to the chase offset. */
  from: THREE.Vector3;
  to: THREE.Vector3;
  targetFrom: THREE.Vector3;
  /** Camera up at entry, blended to the local zenith. */
  upFrom: THREE.Vector3;
  start: number;
  duration: number;
  /**
   * Current heading: the direction of travel in scene space. It is eased
   * towards the object's measured motion so the 1 Hz update does not kink the
   * view.
   */
  forward: THREE.Vector3;
  /**
   * Camera offset in the local orbital frame (x = orbit normal, y = zenith,
   * z = direction of travel). Keeping it in local coordinates makes the chase
   * view rotate with the orbit while still honouring the user's drags.
   */
  local: THREE.Vector3;
  /** Pivot and basis of the previous frame, to carry that offset forward. */
  lastSmooth: THREE.Vector3;
  prevRight: THREE.Vector3;
  prevUp: THREE.Vector3;
  prevForward: THREE.Vector3;
  /** Set once the entry move finishes; from then on the offset is local. */
  chase: boolean;
};

export default forwardRef<GlobeSceneHandle, GlobeSceneProps>(function GlobeScene(
  {
    objects,
    selectedId,
    track,
    onSelect,
    observer,
    sceneTime,
    autoRotate = true,
    popupLabels = DEFAULT_POPUP_LABELS,
    followLabels = DEFAULT_FOLLOW_LABELS,
    classLabel
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    groups: InstancedGroups;
    glow: GlowLayer;
    sunLight: THREE.DirectionalLight;
    /** One detailed body per resolved model key, shown only while following. */
    models: Record<string, THREE.Group>;
    /** Small fill light that travels with the chase camera. */
    followLight: THREE.PointLight;
    idToIndex: Map<string, InstancedIndexEntry>;
    /** Reverse of `idToIndex`: instance id per class, for O(1) picking. */
    pickIds: Record<ObjectClass, string[]>;
    selectedSprite: THREE.Sprite;
    trackLine: THREE.Line;
    cloudMesh: THREE.Mesh;
    observerMarker: THREE.Mesh;
    footprintLine: THREE.LineLoop;
    footprintBand: THREE.Mesh;
    groundTrackLine: THREE.Line;
    fly: {
      from: THREE.Vector3;
      to: THREE.Vector3;
      targetFrom: THREE.Vector3;
      targetTo: THREE.Vector3;
      start: number;
      duration: number;
    } | null;
    /** Chase camera: locks the OrbitControls pivot onto one object. */
    follow: FollowState | null;
    frame: number;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // --- chase camera ---
  // `followingId` mirrors the render-loop state into React so the badge and
  // the Esc/exit button can react to it.
  const [followingId, setFollowingId] = useState<string | null>(null);
  const stopFollowRef = useRef<(() => void) | null>(null);
  /** Stops the chase and flies back to the opening overview shot. */
  const homeRef = useRef<(() => void) | null>(null);
  const autoRotateRef = useRef(autoRotate);
  const selectedIdRef = useRef(selectedId);
  const trackRef = useRef(track);
  const sceneTimeRef = useRef(sceneTime);
  /**
   * Frame-to-frame motion of every object, in scene space. Positions arrive at
   * 1 Hz, so consecutive snapshots give the direction the object is actually
   * travelling on screen — the direction the chase camera has to look along.
   * (The selected object's orbit trace is a render behind at click time, so it
   * cannot be used to aim the entry move.)
   */
  const velocityRef = useRef(new Map<string, THREE.Vector3>());
  const lastScenesRef = useRef(new Map<string, { x: number; y: number; z: number }>());
  useEffect(() => {
    const previous = lastScenesRef.current;
    const next = new Map<string, { x: number; y: number; z: number }>();
    for (const obj of objects) {
      next.set(obj.id, obj.scene);
      const before = previous.get(obj.id);
      if (!before) continue;
      const dx = obj.scene.x - before.x;
      const dy = obj.scene.y - before.y;
      const dz = obj.scene.z - before.z;
      // Ignore re-renders that merely rebuild the array (positions unchanged):
      // zeroing the heading would freeze the chase camera's rotation.
      if (dx * dx + dy * dy + dz * dz < 1e-14) continue;
      const velocity = velocityRef.current.get(obj.id) ?? new THREE.Vector3();
      velocity.set(dx, dy, dz);
      velocityRef.current.set(obj.id, velocity);
    }
    lastScenesRef.current = next;
  }, [objects]);
  useEffect(() => {
    autoRotateRef.current = autoRotate;
    selectedIdRef.current = selectedId;
    trackRef.current = track;
    sceneTimeRef.current = sceneTime;
  }, [autoRotate, selectedId, track, sceneTime]);

  // `popupId` is the only popup state kept in React — the displayed values are
  // read from the live object so they keep ticking while the popup is open.
  const [popupId, setPopupId] = useState<string | null>(null);
  const popupIdRef = useRef<string | null>(null);
  const popupElementRef = useRef<HTMLDivElement | null>(null);

  // Hover identification: the id is React state (it changes rarely), the label
  // position is written straight to the DOM from the render loop.
  const [hoverId, setHoverId] = useState<string | null>(null);
  const hoverIdRef = useRef<string | null>(null);
  const hoverElementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    popupIdRef.current = popupId;
  }, [popupId]);

  useEffect(() => {
    hoverIdRef.current = hoverId;
  }, [hoverId]);

  const popupObject = useMemo(
    () => (popupId ? objects.find((obj) => obj.id === popupId) ?? null : null),
    [objects, popupId]
  );

  // Hide the hover card for the object whose detail popup is already open.
  const hoverObject = useMemo(
    () => (hoverId && hoverId !== popupId ? objects.find((obj) => obj.id === hoverId) ?? null : null),
    [objects, hoverId, popupId]
  );

  const followObject = useMemo(
    () => (followingId ? objects.find((obj) => obj.id === followingId) ?? null : null),
    [objects, followingId]
  );

  const handleExitFollow = () => {
    homeRef.current?.();
    setPopupId(null);
  };

  // -- expose screenshot / camera focus via ref --
  useImperativeHandle(ref, () => ({
    focus: (id: string) => {
      const current = sceneRef.current;
      const entry = current?.idToIndex.get(id);
      if (!current || !entry) return;
      // A globe overview makes no sense while the chase camera owns the view.
      stopFollowRef.current?.();
      const target = new THREE.Vector3(
        entry.object.scene.x,
        entry.object.scene.y,
        entry.object.scene.z
      );
      if (target.lengthSq() === 0) return;
      // Keep the globe in frame at the end of the move: the 2k Earth texture
      // does not hold up closer than this.
      const distance = Math.min(Math.max(current.camera.position.length() * 0.75, 2.55), 3.1);
      current.fly = {
        from: current.camera.position.clone(),
        to: target.normalize().multiplyScalar(distance),
        targetFrom: current.controls.target.clone(),
        targetTo: new THREE.Vector3(0, 0, 0),
        start: performance.now(),
        duration: 620
      };
    },
    home: () => homeRef.current?.(),
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
    scene.background = new THREE.Color("#04060a");

    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.01, 120);
    // Frame the globe the way the reference trackers do: it fills most of the
    // viewport rather than floating small in the middle of it. The azimuth is
    // offset ~73° from the sub-solar point so the opening shot shows the
    // UTC-driven terminator (gibbous Earth) instead of a randomly lit or fully
    // dark disc, which depends on the time of day the page is opened.
    const initialSun = sunDirectionScene(sceneTime);
    const viewAzimuth = Math.atan2(initialSun.z, initialSun.x) + 1.28;
    const elevation = 0.36;
    const distance = 3.8;
    camera.position.set(
      Math.cos(viewAzimuth) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      Math.sin(viewAzimuth) * Math.cos(elevation) * distance
    );

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance"
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    host.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 1.55;
    controls.maxDistance = 14;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 0.18;

    // Soft blue fill keeps the night hemisphere from collapsing into the
    // black background; the sun-aligned directional light still dominates on
    // the day side and paints the terminator.
    const ambient = new THREE.AmbientLight("#7fa0d4", 0.18);
    scene.add(ambient);
    const sunLight = new THREE.DirectionalLight("#fff4e0", 4.2);
    sunLight.position.copy(sunDirectionScene(sceneTime)).multiplyScalar(8);
    scene.add(sunLight);

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

    // The color map is the only texture — no bundled night-lights map. Use a
    // warm fill for the day side (sun) and a cool-blue emissive wash so the
    // night hemisphere reads like a planet against space instead of dropping
    // straight into the black background.
    const earthMat = new THREE.MeshPhongMaterial({
      shininess: 12,
      specular: new THREE.Color("#2b2f36"),
      emissive: new THREE.Color("#06122a"),
      emissiveIntensity: 0.85
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

    // Faint lat/long graticule: the visual signature of a tracker globe,
    // subtle enough not to compete with the photographic texture.
    const graticule = createGraticule(1.002);
    scene.add(graticule);

    // Atmospheric halo. A back-faced shell drawn outside the Earth's
    // silhouette, fading with the distance of each view ray from the planet
    // centre — a soft glow instead of a hard translucent ring.
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 64, 64),
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color("#5aa7e8") },
          uIntensity: { value: 0.45 }
        },
        vertexShader: /* glsl */ `
          varying vec3 vViewPos;
          varying vec3 vCenter;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vViewPos = mv.xyz;
            vCenter = (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor;
          uniform float uIntensity;
          varying vec3 vViewPos;
          varying vec3 vCenter;
          void main() {
            vec3 dir = normalize(vViewPos);
            // Perpendicular distance from this view ray to the planet centre,
            // in Earth radii: 1.0 is the limb, the glow dies out by 1.34.
            float perp = length(vCenter - dir * dot(vCenter, dir));
            float a = 1.0 - smoothstep(0.99, 1.22, perp);
            gl_FragColor = vec4(uColor, a * a * uIntensity);
            #include <colorspace_fragment>
          }
        `,
        transparent: true,
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
      new THREE.LineBasicMaterial({ color: "#fbbf24", transparent: true, opacity: 0.9 })
    );
    footprintLine.frustumCulled = false;
    footprintLine.visible = false;
    scene.add(footprintLine);
    // The chase camera sees the footprint almost edge-on, where a 1 px outline
    // disappears. The same circle is repeated as a thin translucent band so
    // the coverage still reads at a grazing angle.
    const footprintBandGeo = new THREE.BufferGeometry();
    footprintBandGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array((footprintSegments + 1) * 2 * 3), 3)
    );
    const bandIndex: number[] = [];
    for (let i = 0; i < footprintSegments; i += 1) {
      const a = i * 2;
      bandIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    footprintBandGeo.setIndex(bandIndex);
    const footprintBand = new THREE.Mesh(
      footprintBandGeo,
      new THREE.MeshBasicMaterial({
        color: "#fbbf24",
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending
      })
    );
    footprintBand.frustumCulled = false;
    footprintBand.visible = false;
    scene.add(footprintBand);

    // ground track (sub-satellite trail of selected object)
    const groundTrackGeo = new THREE.BufferGeometry();
    const groundTrackLine = new THREE.Line(
      groundTrackGeo,
      new THREE.LineBasicMaterial({ color: "#fde68a", transparent: true, opacity: 0.85 })
    );
    groundTrackLine.frustumCulled = false;
    groundTrackLine.visible = false;
    scene.add(groundTrackLine);

    // additive glow points — one draw call for every visible object
    const glow = createGlowLayer(INITIAL_CAPACITY);
    scene.add(glow.points);

    // Detailed bodies for the chase camera. Only one is visible at a time, so
    // the extra geometry costs nothing while the globe is zoomed out.
    const models = createSatelliteModels();
    const modelAttitudes = Object.fromEntries(
      Object.entries(MODEL_ATTITUDE).map(([type, angles]) => [
        type,
        new THREE.Quaternion().setFromEuler(new THREE.Euler(angles![0], angles![1], angles![2]))
      ])
    ) as Partial<Record<string, THREE.Quaternion>>;
    for (const model of Object.values(models)) {
      model.visible = false;
      // Layer 1 is reserved for the close-up body, so the fill light below can
      // brighten the model without painting a spot on the Earth.
      model.traverse((child) => child.layers.enable(1));
      scene.add(model);
    }
    camera.layers.enable(1);
    // The night side would swallow the model, so a short-range fill light
    // rides with the camera.
    const followLight = new THREE.PointLight("#cfe0ff", 0.72, 2.5, 2);
    followLight.layers.set(1);
    followLight.visible = false;
    scene.add(followLight);

    // -- picking: press/release pair so orbiting the globe does not select --
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let pressedAt: { x: number; y: number } | null = null;

    /**
     * Black out one object's additive dot. While the detailed model is shown
     * the glow would be a 64 px blob painted over its centre.
     */
    const hideGlowPoint = (glowIndex: number, hidden: boolean, entry?: InstancedIndexEntry) => {
      if (glowIndex < 0) return;
      const attribute = glow.geometry.getAttribute("color") as THREE.BufferAttribute;
      const colors = attribute.array as Float32Array;
      const base = glowIndex * 3;
      if (hidden) {
        colors[base] = 0;
        colors[base + 1] = 0;
        colors[base + 2] = 0;
      } else if (entry) {
        const color = new THREE.Color(colorFor(entry.object));
        if (entry.inShadow) color.multiplyScalar(0.6);
        colors[base] = color.r;
        colors[base + 1] = color.g;
        colors[base + 2] = color.b;
      }
      attribute.needsUpdate = true;
    };

    /**
     * The modelled object keeps its instanced copy in the buffer; collapsing
     * its scale hides it so the small unlit primitive cannot poke through the
     * detailed body. Only the uniform scale terms are touched.
     */
    const scaleInstance = (entry: InstancedIndexEntry, scale: number) => {
      const mesh = groups[entry.group];
      const array = mesh.instanceMatrix.array as Float32Array;
      const base = entry.index * 16;
      array[base] = scale;
      array[base + 5] = scale;
      array[base + 10] = scale;
      mesh.instanceMatrix.needsUpdate = true;
    };

    const stopFollow = () => {
      const current = sceneRef.current;
      setFollowingId(null);
      setPopupId(null);
      if (!current?.follow) return;
      const { id } = current.follow;
      current.follow = null;
      camera.up.set(0, 1, 0);
      for (const model of Object.values(models)) model.visible = false;
      followLight.visible = false;
      // Frames the globe again once the user leaves the close-up.
      controls.minDistance = 1.55;
      controls.maxDistance = 14;
      controls.autoRotate = autoRotateRef.current;
      // Restore the overlays hidden for the close-up; the next data tick
      // recomputes their geometry anyway.
      const hasTrack = trackRef.current.length > 1;
      trackLine.visible = hasTrack;
      groundTrackLine.visible = hasTrack;
      // Coverage is a close-up aid; the overview stays clean.
      footprintLine.visible = false;
      footprintBand.visible = false;
      const entry = idToIndex.get(id);
      if (entry) {
        hideGlowPoint(entry.glowIndex, false, entry);
        scaleInstance(entry, 1);
      }
    };
    stopFollowRef.current = stopFollow;

    /**
     * Fly back to the opening overview shot. Also releases the chase view, so
     * one button (or Esc) is enough to get out of the close-up.
     */
    const resetView = () => {
      stopFollow();
      const current = sceneRef.current;
      if (!current) return;
      camera.up.set(0, 1, 0);
      controls.minDistance = 1.55;
      controls.maxDistance = 14;
      controls.autoRotate = autoRotateRef.current;
      // Same framing as the first render: offset from the sub-solar point so
      // the terminator is visible, and far enough out for the globe to fill
      // most of the frame.
      const sun = sunDirectionScene(sceneTimeRef.current);
      const azimuth = Math.atan2(sun.z, sun.x) + 1.28;
      const elevation = 0.36;
      const distance = 3.8;
      current.fly = {
        from: camera.position.clone(),
        to: new THREE.Vector3(
          Math.cos(azimuth) * Math.cos(elevation) * distance,
          Math.sin(elevation) * distance,
          Math.sin(azimuth) * Math.cos(elevation) * distance
        ),
        targetFrom: controls.target.clone(),
        targetTo: new THREE.Vector3(0, 0, 0),
        start: performance.now(),
        duration: 900
      };
    };
    homeRef.current = resetView;

    /**
     * Lock the camera onto one object and chase it down the orbit. The camera
     * sits behind the body along the direction of travel, looking down the
     * tangent so the view turns with the track instead of drifting off it.
     */
    const startFollow = (id: string) => {
      const current = sceneRef.current;
      const entry = idToIndex.get(id);
      if (!current || !entry) return;
      const point = entry.object.scene;
      const position = new THREE.Vector3(point.x, point.y, point.z);
      if (position.lengthSq() < 1e-9) return;

      const radial = position.clone().normalize();

      // Clicking a second object swaps the body without a stop in between;
      // give the previous one its point sprite and instance back first.
      const previous = current.follow;
      if (previous && previous.id !== id) {
        const previousEntry = idToIndex.get(previous.id);
        if (previousEntry) {
          hideGlowPoint(previousEntry.glowIndex, false, previousEntry);
          scaleInstance(previousEntry, 1);
        }
      }

      // Heading: the direction the object is actually moving on screen. The
      // measured 1 Hz motion is authoritative; the selected trace is only a
      // fallback because it still belongs to the previous selection when the
      // click arrives.
      const forward = new THREE.Vector3();
      const velocity = velocityRef.current.get(id);
      if (velocity && velocity.lengthSq() > 1e-12) {
        forward.copy(velocity).normalize();
      } else {
        const samples = trackRef.current;
        if (samples.length > 2 && samples[0].id === id) {
          const a = samples[0].scene;
          const b = samples[1].scene;
          forward.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
        }
        if (forward.lengthSq() < 1e-12) {
          forward.crossVectors(radial, new THREE.Vector3(0, 1, 0));
          if (forward.lengthSq() < 1e-12) forward.crossVectors(radial, new THREE.Vector3(1, 0, 0));
          forward.normalize();
        }
      }
      // Chase in the local horizontal plane: strip any climb/sink component.
      forward.addScaledVector(radial, -forward.dot(radial)).normalize();
      // Travelling "into" the screen, with the local zenith as camera up.
      const right = new THREE.Vector3().crossVectors(radial, forward).normalize();

      const modelKey = resolveModelKey(entry.object);
      for (const model of Object.values(models)) model.visible = false;
      models[modelKey].visible = true;

      const distance = MODEL_VIEW_DISTANCE[modelKey] ?? MODEL_VIEW_DISTANCE.payload;
      const chaseOffset = new THREE.Vector3()
        .addScaledVector(forward, -Math.cos(FOLLOW_ELEVATION) * distance)
        .addScaledVector(radial, Math.sin(FOLLOW_ELEVATION) * distance);
      current.follow = {
        id,
        smooth: position.clone(),
        from: camera.position.clone(),
        to: position.clone().add(chaseOffset),
        targetFrom: controls.target.clone(),
        upFrom: camera.up.clone(),
        start: performance.now(),
        duration: 900,
        forward,
        local: new THREE.Vector3(
          chaseOffset.dot(right),
          chaseOffset.dot(radial),
          chaseOffset.dot(forward)
        ),
        lastSmooth: position.clone(),
        prevRight: right.clone(),
        prevUp: radial.clone(),
        prevForward: forward.clone(),
        chase: false
      };

      hideGlowPoint(entry.glowIndex, true);
      scaleInstance(entry, 0);
      setHoverId(null);
      hoverIdRef.current = null;
      renderer.domElement.style.cursor = "";
      setFollowingId(id);
      followLight.visible = true;
      controls.autoRotate = false;
      controls.minDistance = 0.05;
      controls.maxDistance = Math.max(0.6, distance * 3);
    };

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
      // Grabbing the globe takes back control from an in-flight fly-to.
      if (sceneRef.current) {
        sceneRef.current.fly = null;
        // A drag during the entry move hands the camera straight to the user.
        if (sceneRef.current.follow) sceneRef.current.follow.start = -1;
      }
      // Damping (inertia) adds one frame of lag during the actual drag —
      // disable it while the user holds the pointer so rotation feels
      // immediate, then re-enable for the post-release spin.
      controls.enableDamping = false;
    };

    const handlePointerUp = (event: PointerEvent) => {
      const start = pressedAt;
      pressedAt = null;
      controls.enableDamping = true;
      if (!start) return;
      // A drag is a camera move, not a selection.
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP_PX) return;

      const object = pickAt(event.clientX, event.clientY);
      if (object) {
        onSelectRef.current(object.id);
        // A click flies the camera onto the object and keeps it there while
        // the orbit carries it around the Earth; the info card pins itself to
        // the corner instead of covering the model.
        startFollow(object.id);
        setPopupId(object.id);
        return;
      }
      // Clicked empty space — dismiss the popup. The chase camera stays until
      // it is explicitly released (Esc / the badge button).
      if (sceneRef.current?.follow) return;
      setPopupId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Leaving the close-up returns to the globe overview, so Esc alone is
        // always enough to get back to the starting view.
        resetView();
      }
    };

    // -- hover identification --
    // Projecting every object is O(n); at 16k that is a few milliseconds, so it
    // runs at most every HOVER_THROTTLE_MS and never while the user is dragging
    // (a drag is a camera move).
    let lastHoverCheck = 0;
    const projected = new THREE.Vector3();
    const nearestObjectAt = (clientX: number, clientY: number) => {
      const current = sceneRef.current;
      const rect = renderer.domElement.getBoundingClientRect();
      if (!current || rect.width === 0 || rect.height === 0) return null;
      let bestId: string | null = null;
      let bestDistance = HOVER_RADIUS_PX;
      for (const [id, entry] of current.idToIndex) {
        const point = entry.object.scene;
        projected.set(point.x, point.y, point.z).project(camera);
        if (projected.z > 1) continue;
        const dx = (projected.x * 0.5 + 0.5) * rect.width - (clientX - rect.left);
        const dy = (-projected.y * 0.5 + 0.5) * rect.height - (clientY - rect.top);
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestId = id;
        }
      }
      return bestId;
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (pressedAt) return;
      // The close-up is about the model; a hover card would cover it.
      if (sceneRef.current?.follow) {
        if (hoverIdRef.current !== null) {
          hoverIdRef.current = null;
          setHoverId(null);
        }
        return;
      }
      const now = performance.now();
      if (now - lastHoverCheck < HOVER_THROTTLE_MS) return;
      lastHoverCheck = now;
      const id = nearestObjectAt(event.clientX, event.clientY);
      renderer.domElement.style.cursor = id ? "pointer" : "";
      if (id !== hoverIdRef.current) {
        hoverIdRef.current = id;
        setHoverId(id);
      }
    };

    const handlePointerLeave = () => {
      renderer.domElement.style.cursor = "";
      if (hoverIdRef.current !== null) {
        hoverIdRef.current = null;
        setHoverId(null);
      }
    };

    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("keydown", handleKeyDown);

    const resizeObserver = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      const aspect = host.clientWidth / host.clientHeight;
      camera.aspect = aspect;
      // Portrait viewports have a narrow horizontal field, so a fixed vertical
      // FOV would crop the globe; widen it instead to keep the whole Earth in
      // view on phones.
      camera.fov = aspect < 0.95 ? Math.min(72, 42 / Math.max(aspect, 0.58)) : 42;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resizeObserver.observe(host);

    const followPosition = new THREE.Vector3();
    const followDelta = new THREE.Vector3();
    const followRadial = new THREE.Vector3();
    const followForward = new THREE.Vector3();
    const followDesired = new THREE.Vector3();
    const followRight = new THREE.Vector3();
    const followBasis = new THREE.Matrix4();
    let lastFrameTime = performance.now();

    const animate = () => {
      const now = performance.now();
      const dt = Math.min(Math.max((now - lastFrameTime) / 1000, 0), 0.1);
      lastFrameTime = now;

      // Camera fly-to, cancelled by any manual interaction. The pivot moves
      // with it so a return from the chase view ends up looking at the globe.
      const fly = sceneRef.current?.fly ?? null;
      if (fly) {
        const t = Math.min(1, (now - fly.start) / fly.duration);
        const eased = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(fly.from, fly.to, eased);
        controls.target.lerpVectors(fly.targetFrom, fly.targetTo, eased);
        if (t >= 1 && sceneRef.current) sceneRef.current.fly = null;
      }

      // Chase camera: the pivot rides on the object and the camera keeps a
      // fixed offset in the orbital frame, so the view turns with the track.
      const follow = sceneRef.current?.follow ?? null;
      if (follow) {
        const entry = idToIndex.get(follow.id);
        if (!entry) {
          stopFollow();
        } else {
          const point = entry.object.scene;
          followPosition.set(point.x, point.y, point.z);
          // Propagation posts new positions once per second; easing the pivot
          // turns those steps into a continuous glide.
          follow.smooth.lerp(followPosition, 1 - Math.exp(-dt * 10));

          // Local basis: +X orbit normal, +Y local zenith, +Z the direction of
          // travel (the camera looks along +Z). The heading follows the
          // measured motion, eased so the 1 Hz update does not kink the view.
          followRadial.copy(follow.smooth).normalize();
          const velocity = velocityRef.current.get(follow.id);
          if (velocity && velocity.lengthSq() > 1e-14) {
            followDesired.copy(velocity).normalize();
            if (followDesired.dot(follow.forward) < 0) followDesired.negate();
            followForward
              .copy(follow.forward)
              .lerp(followDesired, 1 - Math.exp(-dt * 6));
            if (followForward.lengthSq() < 1e-10) followForward.copy(followDesired);
          } else {
            followForward.copy(follow.forward);
          }
          // Keep the heading tangential to the local horizon.
          followForward.addScaledVector(followRadial, -followForward.dot(followRadial));
          if (followForward.lengthSq() < 1e-10) followForward.set(0, 0, 1);
          followForward.normalize();
          follow.forward.copy(followForward);
          followRight.crossVectors(followRadial, followForward).normalize();

          if (follow.start > 0) {
            const t = Math.min(1, (now - follow.start) / follow.duration);
            const eased = 1 - Math.pow(1 - t, 3);
            camera.position.lerpVectors(follow.from, follow.to, eased);
            controls.target.lerpVectors(follow.targetFrom, follow.smooth, eased);
            camera.up.lerpVectors(follow.upFrom, followRadial, eased).normalize();
            if (t >= 1) {
              follow.start = 0;
              follow.chase = true;
              follow.lastSmooth.copy(follow.smooth);
              follow.prevRight.copy(followRight);
              follow.prevUp.copy(followRadial);
              follow.prevForward.copy(followForward);
            }
          } else {
            if (!follow.chase) {
              // The entry move was interrupted by a drag: adopt the current
              // camera position as the local offset so there is no jump.
              follow.chase = true;
              follow.lastSmooth.copy(follow.smooth);
              follow.prevRight.copy(followRight);
              follow.prevUp.copy(followRadial);
              follow.prevForward.copy(followForward);
            }
            // Carry the user's orbit/zoom offset across the rotating basis,
            // then rebuild the world position for the new frame. Dragging
            // still works, and the camera keeps looking down the tangent.
            followDelta.copy(camera.position).sub(follow.lastSmooth);
            follow.local.set(
              followDelta.dot(follow.prevRight),
              followDelta.dot(follow.prevUp),
              followDelta.dot(follow.prevForward)
            );
            camera.position
              .copy(follow.smooth)
              .addScaledVector(followRight, follow.local.x)
              .addScaledVector(followRadial, follow.local.y)
              .addScaledVector(followForward, follow.local.z);
            controls.target.copy(follow.smooth);
            camera.up.copy(followRadial);
            follow.lastSmooth.copy(follow.smooth);
            follow.prevRight.copy(followRight);
            follow.prevUp.copy(followRadial);
            follow.prevForward.copy(followForward);
          }

          // Orient the body: +Y is the local zenith, +Z the direction of
          // travel, +X the orbit normal — the attitude a payload holds.
          followBasis.makeBasis(followRight, followRadial, followForward);
          const modelKey = resolveModelKey(entry.object);
          const model = models[modelKey] ?? models.payload;
          model.position.copy(follow.smooth);
          model.quaternion.setFromRotationMatrix(followBasis);
          const attitude = modelAttitudes[modelKey];
          if (attitude) model.quaternion.multiply(attitude);

          // Orbiting the pivot must not sink the camera below the surface.
          const radius = camera.position.length();
          if (radius < 1.05) camera.position.multiplyScalar(1.05 / radius);
          // Sit the fill light up and to one side so the body gets a modelled
          // highlight instead of a flat frontal wash.
          followLight.position
            .copy(camera.position)
            .addScaledVector(followRadial, 0.16)
            .addScaledVector(followRight, 0.07);

          // Globe-scale overlays (orbit trace, ground track) cut straight
          // through the model at this distance. The coverage circle is the
          // exception: the follow view is where it is actually useful.
          selectedSprite.visible = false;
          trackLine.visible = false;
          groundTrackLine.visible = false;
          footprintLine.visible = true;
          footprintBand.visible = true;
        }
      }

      controls.update();
      // Point sprites are sized in device pixels, so the projection scale is
      // derived from the live drawing-buffer height every frame (it changes
      // with zoom, viewport and pixel ratio).
      glow.material.uniforms.uScale.value =
        renderer.domElement.height / (2 * Math.tan((camera.fov * Math.PI) / 360));
      // Satellite positions and the observer use an Earth-fixed frame. Keep
      // geography fixed in that frame; OrbitControls supplies camera rotation.
      cloudMesh.rotation.y += 0.00055;
      atmosphere.rotation.y += 0.00025;

      // Keep the info popup glued to its object. While following, the card is
      // pinned by CSS to the corner so it does not cover the model.
      const popupElement = popupElementRef.current;
      const activePopupId = popupIdRef.current;
      if (popupElement && activePopupId && !sceneRef.current?.follow) {
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

      // The hover card tracks the object, so it stays readable while the
      // constellation drifts underneath the pointer.
      const hoverElement = hoverElementRef.current;
      const activeHoverId = hoverIdRef.current;
      if (hoverElement && activeHoverId) {
        const entry = idToIndex.get(activeHoverId);
        if (entry) {
          projected.set(entry.object.scene.x, entry.object.scene.y, entry.object.scene.z);
          projected.project(camera);
          const rect = renderer.domElement.getBoundingClientRect();
          const x = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
          const y = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
          hoverElement.style.transform = `translate(${x}px, ${y}px) translate(14px, -50%)`;
          hoverElement.style.visibility = projected.z > 1 ? "hidden" : "visible";
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
      glow,
      sunLight,
      models,
      followLight,
      idToIndex,
      pickIds,
      selectedSprite,
      trackLine,
      cloudMesh,
      observerMarker,
      footprintLine,
      footprintBand,
      groundTrackLine,
      fly: null,
      follow: null,
      frame: requestAnimationFrame(animate)
    };

    return () => {
      disposed = true;
      const cur = sceneRef.current;
      stopFollowRef.current = null;
      homeRef.current = null;
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("keydown", handleKeyDown);
      if (cur) cancelAnimationFrame(cur.frame);
      controls.dispose();
      earthMat.dispose();
      earth.geometry.dispose();
      graticule.geometry.dispose();
      (graticule.material as THREE.Material).dispose();
      atmosphere.geometry.dispose();
      (atmosphere.material as THREE.Material).dispose();
      for (const g of Object.values(cur?.groups ?? groups)) {
        (g.material as THREE.Material).dispose();
        g.dispose();
      }
      glow.geometry.dispose();
      glow.material.dispose();
      disposeSatelliteModels(models);
      for (const texture of textures) texture.dispose();
      for (const line of [trackLine, footprintLine, groundTrackLine]) {
        (line.material as THREE.Material).dispose();
      }
      (footprintBand.material as THREE.Material).dispose();
      footprintBandGeo.dispose();
      trackGeo.dispose();
      footprintGeo.dispose();
      groundTrackGeo.dispose();
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
    autoRotateRef.current = autoRotate;
    const cur = sceneRef.current;
    if (!cur) return;
    // The chase camera owns the view while it is locked on an object.
    if (!cur.follow) cur.controls.autoRotate = autoRotate;
  }, [autoRotate]);

  // ---- leave the follow view when the selection moves elsewhere ----
  // Picking another object from the list should put the camera back on the
  // globe, where the new selection is actually visible.
  useEffect(() => {
    if (!followingId) return;
    if (selectedId === followingId) return;
    homeRef.current?.();
  }, [selectedId, followingId]);

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
    // The chase camera hides its object's glow dot behind the detailed model;
    // this pass rewrites every dot, so re-apply that here.
    const followingId = cur.follow?.id ?? null;

    // The glow layer mirrors the same list, so it is grown and rewritten here
    // instead of in a second pass over 16k objects.
    ensureGlowCapacity(cur.glow, objects.length);
    const glowPosition = cur.glow.geometry.getAttribute("position") as THREE.BufferAttribute;
    const glowColor = cur.glow.geometry.getAttribute("color") as THREE.BufferAttribute;
    const glowPositions = glowPosition.array as Float32Array;
    const glowColors = glowColor.array as Float32Array;
    let glowIndex = 0;

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
      // A capacity regrow reseeds identity matrices, which would bring the
      // followed object's primitive back through its detailed model.
      if (obj.id === followingId) {
        array[base] = 0;
        array[base + 5] = 0;
        array[base + 10] = 0;
      }

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
        glowIndex,
        baseColor: baseHex,
        inShadow: obj.inShadow,
        object: obj
      });

      // Glow: brighter than the mesh so objects read at full-globe zoom, and
      // dimmed in eclipse — the same cue the meshes use.
      const glowBase = glowIndex * 3;
      glowPositions[glowBase] = obj.scene.x;
      glowPositions[glowBase + 1] = obj.scene.y;
      glowPositions[glowBase + 2] = obj.scene.z;
      if (obj.id === followingId) {
        glowColors[glowBase] = 0;
        glowColors[glowBase + 1] = 0;
        glowColors[glowBase + 2] = 0;
      } else {
        reusableColor.set(obj.id === selectedId ? SELECTED_COLOR : baseHex);
        if (obj.id !== selectedId && obj.inShadow) reusableColor.multiplyScalar(0.6);
        glowColors[glowBase] = reusableColor.r;
        glowColors[glowBase + 1] = reusableColor.g;
        glowColors[glowBase + 2] = reusableColor.b;
      }
      glowIndex += 1;
    }

    glowPosition.needsUpdate = true;
    glowColor.needsUpdate = true;
    cur.glow.points.geometry.setDrawRange(0, glowIndex);

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
    // While following, the ring would sit on the detailed model.
    cur.selectedSprite.visible = !cur.follow;
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
      cur.footprintBand.visible = false;
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
    // Ride just above the cloud shell (radius 1.012); below it the coverage
    // would be occluded by the clouds on the day side.
    const r = 1.014;
    const sinA = Math.sin(halfAngle);
    const cosA = Math.cos(halfAngle);
    const segments = 96;
    const positions = cur.footprintLine.geometry.getAttribute("position") as THREE.BufferAttribute;
    const bandPositions = cur.footprintBand.geometry.getAttribute("position") as THREE.BufferAttribute;
    // Band edges: wide enough to survive the grazing chase-camera angle, and
    // scaled with the footprint so a GEO cap does not get a hairline.
    const bandHalf = Math.max(0.01, sinA * 0.1);
    const innerSin = Math.sin(halfAngle - bandHalf);
    const innerCos = Math.cos(halfAngle - bandHalf);
    const outerSin = Math.sin(halfAngle + bandHalf);
    const outerCos = Math.cos(halfAngle + bandHalf);
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * Math.PI * 2;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const at = (sin: number, cos: number, slot: number) => {
        const x = cos * cx + sin * (ct * ux + st * vx);
        const y = cos * cy + sin * (ct * uy + st * vy);
        const z = cos * cz + sin * (ct * uz + st * vz);
        if (slot < 0) positions.setXYZ(i, x * r, y * r, z * r);
        else bandPositions.setXYZ(i * 2 + slot, x * r, y * r, z * r);
      };
      at(sinA, cosA, -1);
      at(innerSin, innerCos, 0);
      at(outerSin, outerCos, 1);
    }
    positions.needsUpdate = true;
    bandPositions.needsUpdate = true;
    // The coverage circle is part of the close-up: it appears when the chase
    // camera locks onto the object and is hidden in the overview.
    cur.footprintLine.visible = followingId === selectedObject.id;
    cur.footprintBand.visible = followingId === selectedObject.id;
  }, [selectedObject, objects, followingId]);

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

  // ---- sun-aligned key light ----
  // The globe is lit from the real sub-solar direction, so the day/night
  // boundary on the surface agrees with the eclipse shading applied to the
  // objects above it. Re-aimed whenever scene time moves.
  useEffect(() => {
    const cur = sceneRef.current;
    if (!cur) return;
    cur.sunLight.position.copy(sunDirectionScene(sceneTime)).multiplyScalar(8);
  }, [sceneTime]);

  return (
    <div className="globe-shell" data-testid="globe-scene">
      <div ref={hostRef} className="globe-canvas" />
      <div className="scene-vignette" />
      {followObject ? (
        <div className="sat-follow" role="status">
          <span className="sat-follow-dot" aria-hidden />
          <span className="sat-follow-text">
            {followLabels.following} · <strong>{followObject.name}</strong>
          </span>
          <button type="button" className="sat-follow-exit" onClick={handleExitFollow}>
            {followLabels.exit}
          </button>
        </div>
      ) : null}
      {popupObject ? (
        <div
          ref={popupElementRef}
          className={`sat-popup${followingId && popupId === followingId ? " sat-popup-pinned" : ""}`}
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
              <span>{popupLabels.classification}</span>
              <strong>{classLabel ? classLabel(popupObject.objectType) : popupObject.objectType}</strong>
            </div>
            <div className="sat-popup-row">
              <span>{popupLabels.altitude}</span>
              <strong>{popupObject.altitudeKm.toFixed(1)} km</strong>
            </div>
            <div className="sat-popup-row">
              <span>{popupLabels.speed}</span>
              <strong>{popupObject.speedKmS.toFixed(3)} km/s</strong>
            </div>
            <div className="sat-popup-row">
              <span>{popupLabels.period}</span>
              <strong>{orbitalPeriodMinutes(popupObject.altitudeKm).toFixed(1)} min</strong>
            </div>
          </div>
        </div>
      ) : null}
      {hoverObject ? (
        <div ref={hoverElementRef} className="sat-hover" aria-hidden>
          <span className="sat-hover-name">{hoverObject.name}</span>
          <span className="sat-hover-meta">
            {hoverObject.noradId} · {hoverObject.altitudeKm.toFixed(0)} km
            {classLabel ? ` · ${classLabel(hoverObject.objectType)}` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
});
