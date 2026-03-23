import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["placeholder.svg", "robots.txt"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,ttf,woff,woff2}"],
        navigateFallbackDenylist: [/^\/~oauth/],
        runtimeCaching: [],
      },
      manifest: {
        name: "Generative Design Explorer",
        short_name: "GDE",
        description: "أداة التصميم الإنشائي التوليدي",
        theme_color: "#1a365d",
        background_color: "#f0f2f5",
        display: "standalone",
        orientation: "portrait",
        scope: "/",
        start_url: "/",
        icons: [
          {
            src: "/placeholder.svg",
            sizes: "192x192",
            type: "image/svg+xml",
          },
          {
            src: "/placeholder.svg",
            sizes: "512x512",
            type: "image/svg+xml",
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
