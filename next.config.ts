import type { NextConfig } from "next";

const snapshotMode = process.env.NEXT_PUBLIC_DATA_MODE === "snapshot";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const nextConfig: NextConfig = {
  typedRoutes: true,
  output: "standalone",
  basePath,
  distDir: snapshotMode ? ".next-static" : ".next",
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // The pass predictor asks for the observer position, so geolocation
          // stays available to this origin; everything else is denied.
          { key: "Permissions-Policy", value: "geolocation=(self), camera=(), microphone=()" }
        ]
      }
    ];
  }
};

export default nextConfig;
