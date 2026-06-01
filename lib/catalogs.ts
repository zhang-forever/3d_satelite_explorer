export type CatalogKind = "core" | "operator" | "navigation" | "science" | "debris" | "special";

export type CatalogDefinition = {
  id: string;
  label: {
    zh: string;
    en: string;
  };
  description: {
    zh: string;
    en: string;
  };
  queryKey: "GROUP" | "SPECIAL";
  queryValue: string;
  kind: CatalogKind;
  color: string;
  defaultSelected?: boolean;
  includesDebris?: boolean;
};

export const CATALOGS: CatalogDefinition[] = [
  {
    id: "active",
    label: { zh: "活跃物体", en: "Active" },
    description: { zh: "公开活跃航天器核心目录", en: "Core public active spacecraft catalog" },
    queryKey: "GROUP",
    queryValue: "active",
    kind: "core",
    color: "#22d3ee",
    defaultSelected: true
  },
  {
    id: "stations",
    label: { zh: "空间站", en: "Stations" },
    description: { zh: "载人空间站与相关舱段", en: "Crewed stations and related modules" },
    queryKey: "GROUP",
    queryValue: "stations",
    kind: "core",
    color: "#fbbf24"
  },
  {
    id: "last-30-days",
    label: { zh: "近 30 天", en: "Last 30 days" },
    description: { zh: "最近发射或新发布的物体", en: "Recently launched or newly published objects" },
    queryKey: "GROUP",
    queryValue: "last-30-days",
    kind: "core",
    color: "#f472b6"
  },
  {
    id: "starlink",
    label: { zh: "Starlink", en: "Starlink" },
    description: { zh: "Starlink 星座", en: "Starlink constellation" },
    queryKey: "GROUP",
    queryValue: "starlink",
    kind: "operator",
    color: "#38bdf8"
  },
  {
    id: "oneweb",
    label: { zh: "OneWeb", en: "OneWeb" },
    description: { zh: "OneWeb 星座", en: "OneWeb constellation" },
    queryKey: "GROUP",
    queryValue: "oneweb",
    kind: "operator",
    color: "#a78bfa"
  },
  {
    id: "planet",
    label: { zh: "Planet", en: "Planet" },
    description: { zh: "Planet 观测星座", en: "Planet imaging constellation" },
    queryKey: "GROUP",
    queryValue: "planet",
    kind: "operator",
    color: "#34d399"
  },
  {
    id: "gps-ops",
    label: { zh: "GPS", en: "GPS" },
    description: { zh: "GPS 在轨运行星", en: "Operational GPS satellites" },
    queryKey: "GROUP",
    queryValue: "gps-ops",
    kind: "navigation",
    color: "#60a5fa"
  },
  {
    id: "glo-ops",
    label: { zh: "GLONASS", en: "GLONASS" },
    description: { zh: "GLONASS 在轨运行星", en: "Operational GLONASS satellites" },
    queryKey: "GROUP",
    queryValue: "glo-ops",
    kind: "navigation",
    color: "#f87171"
  },
  {
    id: "galileo",
    label: { zh: "Galileo", en: "Galileo" },
    description: { zh: "Galileo 导航星座", en: "Galileo navigation constellation" },
    queryKey: "GROUP",
    queryValue: "galileo",
    kind: "navigation",
    color: "#facc15"
  },
  {
    id: "beidou",
    label: { zh: "北斗", en: "BeiDou" },
    description: { zh: "北斗导航星座", en: "BeiDou navigation constellation" },
    queryKey: "GROUP",
    queryValue: "beidou",
    kind: "navigation",
    color: "#fb923c"
  },
  {
    id: "weather",
    label: { zh: "气象", en: "Weather" },
    description: { zh: "气象与环境监测卫星", en: "Weather and environmental monitoring satellites" },
    queryKey: "GROUP",
    queryValue: "weather",
    kind: "science",
    color: "#5eead4"
  },
  {
    id: "science",
    label: { zh: "科学", en: "Science" },
    description: { zh: "科学任务卫星", en: "Science mission satellites" },
    queryKey: "GROUP",
    queryValue: "science",
    kind: "science",
    color: "#c084fc"
  },
  {
    id: "geo",
    label: { zh: "地球同步", en: "GEO" },
    description: { zh: "地球同步轨道物体", en: "Geosynchronous objects" },
    queryKey: "GROUP",
    queryValue: "geo",
    kind: "core",
    color: "#fde68a"
  },
  {
    id: "cosmos-2251-debris",
    label: { zh: "COSMOS 2251 碎片", en: "COSMOS 2251 debris" },
    description: { zh: "COSMOS 2251 碰撞碎片", en: "COSMOS 2251 collision debris" },
    queryKey: "GROUP",
    queryValue: "cosmos-2251-debris",
    kind: "debris",
    color: "#ef4444",
    includesDebris: true
  },
  {
    id: "iridium-33-debris",
    label: { zh: "IRIDIUM 33 碎片", en: "IRIDIUM 33 debris" },
    description: { zh: "IRIDIUM 33 碰撞碎片", en: "IRIDIUM 33 collision debris" },
    queryKey: "GROUP",
    queryValue: "iridium-33-debris",
    kind: "debris",
    color: "#dc2626",
    includesDebris: true
  },
  {
    id: "fengyun-1c-debris",
    label: { zh: "风云一号 C 碎片", en: "Fengyun 1C debris" },
    description: { zh: "风云一号 C 碎片", en: "Fengyun 1C debris" },
    queryKey: "GROUP",
    queryValue: "fengyun-1c-debris",
    kind: "debris",
    color: "#b91c1c",
    includesDebris: true
  },
  {
    id: "decaying",
    label: { zh: "潜在再入", en: "Potential decays" },
    description: { zh: "近期可能衰减再入的物体", en: "Objects with potential near-term decay" },
    queryKey: "SPECIAL",
    queryValue: "DECAYING",
    kind: "special",
    color: "#fb7185",
    includesDebris: true
  },
  {
    id: "gpz",
    label: { zh: "GEO 保护区", en: "GEO protected zone" },
    description: { zh: "CelesTrak GEO Protected Zone 数据集", en: "CelesTrak GEO Protected Zone dataset" },
    queryKey: "SPECIAL",
    queryValue: "GPZ",
    kind: "special",
    color: "#94a3b8"
  }
];

export function getCatalogById(id: string) {
  return CATALOGS.find((catalog) => catalog.id === id);
}
