import type { NextConfig } from "next";

const snapshotMode = process.env.NEXT_PUBLIC_DATA_MODE === "snapshot";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  typedRoutes: true,
  output: "standalone",
  basePath,
  distDir: snapshotMode ? ".next-static" : ".next"
};

export default nextConfig;
