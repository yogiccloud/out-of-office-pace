import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const base = process.env.VITE_BASE_PATH || "/";
const assetPath = (path: string) => `${base.replace(/\/?$/, "/")}${path}`;

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["pwa-192.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "Out Of Office Pace",
        short_name: "OOO Pace",
        description: "Your Personal Race Vault.",
        theme_color: "#c7f36b",
        background_color: "#101714",
        display: "standalone",
        orientation: "portrait",
        start_url: base,
        icons: [
          { src: assetPath("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
          { src: assetPath("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
          { src: assetPath("pwa-192.svg"), sizes: "192x192", type: "image/svg+xml", purpose: "maskable" },
          { src: assetPath("pwa-512.svg"), sizes: "512x512", type: "image/svg+xml", purpose: "maskable" }
        ]
      },
      workbox: {
        navigateFallback: assetPath("index.html"),
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"]
      }
    })
  ]
});