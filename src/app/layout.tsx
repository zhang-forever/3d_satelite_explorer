import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orbital Field · 轨道场",
  description: "Explore satellites and space debris in 3D with public CelesTrak orbital data. 浏览卫星与空间碎片的三维轨道、交会与过境。"
};

export const viewport: Viewport = {
  themeColor: "#050713",
  colorScheme: "dark"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
