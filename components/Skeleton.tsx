"use client";

export type SkeletonVariant = "text" | "circle" | "rect" | "row";

type SkeletonProps = {
  variant?: SkeletonVariant;
  width?: number | string;
  height?: number | string;
  count?: number;
  className?: string;
};

const baseStyle = {
  borderRadius: 6,
  background:
    "linear-gradient(90deg, rgba(148,163,184,0.08) 25%, rgba(148,163,184,0.18) 50%, rgba(148,163,184,0.08) 75%)",
  backgroundSize: "200% 100%",
  animation: "skeleton-pulse 1.5s ease-in-out infinite",
};

const variantStyles: Record<SkeletonVariant, React.CSSProperties> = {
  text: { height: 14, width: "100%" },
  circle: { borderRadius: "50%", width: 36, height: 36 },
  rect: { width: "100%", height: 58 },
  row: { width: "100%", height: 34, borderRadius: 8 },
};

export default function Skeleton({
  variant = "text",
  width,
  height,
  count = 1,
  className
}: SkeletonProps) {
  return (
    <>
      <style>{`
        @keyframes skeleton-pulse {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      <div
        className={className}
        style={{ display: "grid", gap: 8 }}
        aria-hidden="true"
      >
        {Array.from({ length: count }).map((_, i) => (
          <div
            key={i}
            style={{
              ...baseStyle,
              ...variantStyles[variant],
              width: width ?? variantStyles[variant].width,
              height: height ?? variantStyles[variant].height,
            }}
          />
        ))}
      </div>
    </>
  );
}

export function CatalogSkeleton() {
  return (
    <div className="catalog-list" aria-label="Loading catalogs">
      <Skeleton variant="rect" count={5} />
    </div>
  );
}

export function InspectorSkeleton() {
  return (
    <div style={{ display: "grid", gap: 12 }} aria-label="Loading satellite details">
      <Skeleton variant="text" width="60%" />
      <Skeleton variant="text" width="40%" />
      <Skeleton variant="row" count={6} />
    </div>
  );
}

export function TopbarSkeleton() {
  return (
    <div className="topbar" aria-label="Loading status bar">
      <Skeleton variant="row" width={120} />
      <Skeleton variant="row" width={100} />
      <Skeleton variant="row" width={200} />
    </div>
  );
}
