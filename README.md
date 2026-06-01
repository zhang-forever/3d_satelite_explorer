# Orbital Field · 轨道场

A real‑time **3D viewer for objects in Earth orbit** — satellites, rocket bodies, and debris — built with Next.js, Three.js, and SGP4 propagation. Load live catalogs from CelesTrak, watch thousands of objects propagate in real time, and run conjunction (rendezvous) and ground‑pass analysis right in the browser.

一个**地球在轨物体的实时 3D 可视化应用** —— 卫星、火箭体、空间碎片 —— 基于 Next.js、Three.js 与 SGP4 轨道传播。从 CelesTrak 加载实时目录,实时传播上千个物体,并在浏览器内完成交会接近分析与地面过境预测。

**[English](#-english) · [中文](#-中文)**

> ⚠️ For visualization and education only. Orbits use SGP4 from public TLE/OMM data and are **not** suitable for operational collision avoidance.
> ⚠️ 仅用于可视化与教学。轨道由公开 TLE/OMM 数据经 SGP4 计算得到,**不可**用于实际的碰撞规避决策。

---

## 🇬🇧 English

### Features

**3D globe (Three.js)**
- Textured Earth with normal/specular maps, animated clouds, atmosphere glow, and a procedural starfield.
- Instanced rendering of up to **16,000** objects, with a distinct mesh per class: payload (bus + solar panels + dish), rocket body (cylinder + nose cone), debris (irregular tetrahedron), and unknown (sphere).
- **Eclipse shading** — objects inside Earth's shadow are dimmed, and a day/night **terminator** great circle is drawn from the Sun's sub‑solar point.
- Click any object to select it (GPU raycasting); auto‑rotating camera with damped `OrbitControls`.
- For the selected object: inertial **orbit track**, **ground track** (sub‑satellite trail), **footprint** coverage circle, and a highlight ring.

**Live data & catalogs**
- 18 color‑coded CelesTrak groups: Active, Stations, Last 30 days, Starlink, OneWeb, Planet, GPS, GLONASS, Galileo, BeiDou, Weather, Science, GEO, three debris clouds (COSMOS 2251 / IRIDIUM 33 / Fengyun‑1C), Potential decays, and the GEO Protected Zone.
- Load/unload each group on demand; objects are merged into a single propagation set.
- **Server‑side cache** (`.cache/celestrak`, 4‑hour TTL) with `ETag` / `If‑Modified‑Since` conditional requests and stale‑on‑error fallback, so CelesTrak is never hammered.

**Propagation & time**
- SGP4 via [`satellite.js`](https://github.com/shashwatak/satellite-js), executed in a **Web Worker** to keep the UI at 60 fps.
- Time controls: play/pause, speed multipliers (0× / 1× / 10× / 60× / 600×), a −24h…+24h scrub slider, and a "live" reset.

**Filters**
- Free‑text search over name / NORAD ID / international designator.
- Class filter (all / payload / debris / rocket / unknown), a debris toggle, and a min–max altitude band.

**Orbit analysis**
- **Rendezvous scan** — scans the selected primary against every loaded object for close approaches within a chosen window (6–72 h) and miss distance (5–200 km). Uses altitude‑band pre‑filtering plus coarse + refined time sampling, and reports closest‑approach time, miss distance, relative speed, current separation, and the sub‑point of closest approach.
- **Pass prediction** — visible passes over an observer (manual lat/lon or browser geolocation) in the next 48 h, with a minimum‑elevation filter, rise/set compass azimuths, peak elevation, and duration.

**Quality‑of‑life**
- **Watchlist** starred objects, persisted in `localStorage`.
- **Export** the selected object's OMM record as JSON.
- Bilingual UI (中文 / English), auto‑detected from the browser and toggleable.
- Collapsible side rails and panels.

### Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js (App Router, React 19) |
| Language | TypeScript |
| 3D | Three.js (`InstancedMesh`, `OrbitControls`) |
| Orbital mechanics | `satellite.js` (SGP4 / OMM) |
| Icons | `lucide-react` |
| Data source | [CelesTrak GP](https://celestrak.org/NORAD/elements/) (OMM JSON) |
| Tests | Vitest + Testing Library + jsdom |

### Getting started

**Prerequisites:** Node.js **18.18+** or **20+**. Internet access is needed at runtime for the CelesTrak GP API; the Earth textures ship locally under `public/textures/`.

```bash
# install dependencies
npm install

# start the dev server
npm run dev
# open http://localhost:3000
```

No environment variables or API keys are required — CelesTrak's GP API is public.

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build (`next build --webpack`) |
| `npm start` | Serve the production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |

### Project structure

```
app/
  api/
    catalogs/route.ts   # catalog summaries + cache status
    gp/route.ts         # per-group GP/OMM fetch (cached)
  layout.tsx            # root layout & metadata
  page.tsx              # renders <SatelliteExplorer />
components/
  SatelliteExplorer.tsx # app shell: state, panels, filters, analysis
  GlobeScene.tsx        # Three.js scene, instancing, overlays
lib/
  catalogs.ts           # the 18 CelesTrak group definitions
  celestrakCache.ts     # file cache + conditional fetch logic
  orbit.ts              # SGP4 helpers, rendezvous & track sampling
  passes.ts             # observer pass prediction
  propagationWorker.ts  # Web Worker: propagate + rendezvous scan
  i18n.ts               # zh / en copy
tests/                  # cache / orbit / passes unit tests
```

### How it works

1. On load, the client asks `/api/catalogs` for group metadata, then requests each group via `/api/gp?group=…`.
2. The server checks its 4‑hour file cache; on a miss it fetches CelesTrak with conditional headers and stores the OMM JSON.
3. OMM records are pushed to a Web Worker, which builds SGP4 `satrec`s and propagates every object to the current scene time.
4. Propagated positions stream back to the main thread and are written into Three.js `InstancedMesh` buffers — one draw call per object class.
5. Selecting an object triggers track sampling, footprint/ground‑track overlays, and an on‑demand rendezvous scan inside the worker.

### Data & attribution

Orbital data is provided by **[CelesTrak](https://celestrak.org/)** (Dr. T.S. Kelso). Please review and respect CelesTrak's usage guidelines. Earth textures (`public/textures/earth_atmos_2048.jpg`, `earth_normal_2048.jpg`, `earth_specular_2048.jpg`, `earth_clouds_1024.png`) are local copies of the public Three.js example assets from `threejs.org/examples/textures/planets/`.

---

## 🇨🇳 中文

### 功能特性

**3D 地球(Three.js)**
- 带法线/高光贴图的地球、动态云层、大气辉光,以及程序生成的星空背景。
- 实例化(InstancedMesh)渲染,最多 **16000** 个物体,按类型使用不同几何体:载荷(本体 + 太阳能板 + 天线)、火箭体(柱体 + 锥头)、碎片(不规则四面体)、未知(球体)。
- **地影遮蔽** —— 处于地球阴影内的物体会变暗,并依据太阳直下点绘制昼夜 **晨昏线** 大圆。
- 点击任意物体即可选中(GPU 射线拾取);相机自动旋转,带阻尼 `OrbitControls`。
- 针对选中物体:惯性系 **轨道线**、**星下点轨迹**、地面 **覆盖圈**,以及高亮选择环。

**实时数据与目录**
- 18 个带配色的 CelesTrak 分组:活跃物体、空间站、近 30 天、Starlink、OneWeb、Planet、GPS、GLONASS、Galileo、北斗、气象、科学、地球同步,三个碎片云(COSMOS 2251 / IRIDIUM 33 / 风云一号 C)、潜在再入,以及 GEO 保护区。
- 每个分组可按需加载/卸载;所有已加载物体合并到统一的传播集合中。
- **服务端缓存**(`.cache/celestrak`,4 小时有效期),使用 `ETag` / `If‑Modified‑Since` 条件请求,出错时回退到旧缓存,避免对 CelesTrak 的频繁请求。

**轨道传播与时间**
- 通过 [`satellite.js`](https://github.com/shashwatak/satellite-js) 实现 SGP4,并放在 **Web Worker** 中计算,保证界面流畅。
- 时间控制:播放/暂停,倍速(0× / 1× / 10× / 60× / 600×),−24h…+24h 拖动滑块,以及"实时"复位。

**筛选**
- 按名称 / NORAD ID / 国际编号进行文本搜索。
- 类型筛选(全部 / 载荷 / 碎片 / 火箭体 / 未知)、碎片开关,以及高度上下限区间。

**轨道分析**
- **交会扫描** —— 在指定窗口(6–72 小时)和阈值距离(5–200 km)内,将选中的主目标与全部已加载物体逐一比对最近接近事件。采用高度带预筛选 + 粗采样 + 细化采样,输出最近接近时刻、最近距离、相对速度、当前距离,以及最近点的星下位置。
- **过境预测** —— 计算未来 48 小时内卫星过境观测点(手动输入经纬度或使用浏览器定位)的可见过境,支持最低仰角筛选,给出升起/落下方位(罗盘方向)、最高仰角与持续时长。

**易用性**
- **关注列表**:为物体加星标,保存在 `localStorage`。
- **导出**:将选中物体的 OMM 记录导出为 JSON。
- 中英双语界面,根据浏览器自动识别,可手动切换。
- 可折叠的侧栏与面板。

### 技术栈

| 层级 | 选型 |
|---|---|
| 框架 | Next.js(App Router,React 19) |
| 语言 | TypeScript |
| 3D | Three.js（`InstancedMesh`、`OrbitControls`) |
| 轨道力学 | `satellite.js`(SGP4 / OMM) |
| 图标 | `lucide-react` |
| 数据源 | [CelesTrak GP](https://celestrak.org/NORAD/elements/)（OMM JSON) |
| 测试 | Vitest + Testing Library + jsdom |

### 快速开始

**环境要求:** Node.js **18.18+** 或 **20+**。运行时仅需联网访问 CelesTrak GP 接口;地球贴图已随仓库附带在 `public/textures/`。

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
# 浏览器打开 http://localhost:3000
```

无需任何环境变量或 API 密钥 —— CelesTrak 的 GP 接口是公开的。

### 命令脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run build` | 生产构建(`next build --webpack`) |
| `npm start` | 运行生产构建 |
| `npm run lint` | 运行 ESLint |
| `npm test` | 运行一次 Vitest 测试 |
| `npm run test:watch` | 以监视模式运行 Vitest |

### 项目结构

```
app/
  api/
    catalogs/route.ts   # 目录摘要 + 缓存状态
    gp/route.ts         # 按分组拉取 GP/OMM（带缓存）
  layout.tsx            # 根布局与元数据
  page.tsx              # 渲染 <SatelliteExplorer />
components/
  SatelliteExplorer.tsx # 应用主体：状态、面板、筛选、分析
  GlobeScene.tsx        # Three.js 场景、实例化、各类叠加层
lib/
  catalogs.ts           # 18 个 CelesTrak 分组定义
  celestrakCache.ts     # 文件缓存 + 条件请求逻辑
  orbit.ts              # SGP4 辅助、交会计算与轨迹采样
  passes.ts             # 观测点过境预测
  propagationWorker.ts  # Web Worker：传播 + 交会扫描
  i18n.ts               # 中 / 英 文案
tests/                  # cache / orbit / passes 单元测试
```

### 工作原理

1. 加载时,客户端向 `/api/catalogs` 请求分组元数据,再通过 `/api/gp?group=…` 拉取每个分组。
2. 服务端先查 4 小时文件缓存;未命中时带条件请求头从 CelesTrak 拉取,并存储 OMM JSON。
3. OMM 记录被发送到 Web Worker,构建 SGP4 `satrec` 并将每个物体传播到当前场景时间。
4. 传播得到的位置回传主线程,写入 Three.js `InstancedMesh` 缓冲 —— 每个物体类型一次绘制调用。
5. 选中物体会触发轨迹采样、覆盖圈/星下点叠加层,以及在 Worker 内按需运行的交会扫描。

### 数据与署名

轨道数据来自 **[CelesTrak](https://celestrak.org/)**(Dr. T.S. Kelso)。请阅读并遵守 CelesTrak 的使用条款。地球贴图(`public/textures/earth_atmos_2048.jpg`、`earth_normal_2048.jpg`、`earth_specular_2048.jpg`、`earth_clouds_1024.png`)是 Three.js 官方示例公开素材的本地副本,源自 `threejs.org/examples/textures/planets/`。

---

## License · 许可

Released under the **MIT License** — see [LICENSE](./LICENSE).
基于 **MIT 许可证** 发布,详见 [LICENSE](./LICENSE)。
