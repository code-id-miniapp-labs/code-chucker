import { defineConfig } from "weapp-vite";
import { codeUI } from "@code-id-labs/plugin-vite";
import chuckerPlugin from "@code-id-labs/code-chucker";

export default defineConfig(({ mode }) => ({
  weapp: {
    srcRoot: "src",
    platform: "weapp",
    tailwindcss: {
      cssEntries: ["src/app.css"],
      cssOptions: {
        rem2rpx: true,
        autoprefixer: true,
      },
    },
    hmr: {
      runtime: "classic",
    },
    generate: {
      extensions: {
        js: "ts",
      },
      dirs: {
        component: "src/components",
        page: "src/pages",
      },
    },
  },
  plugins: [
    codeUI({
      autoImport: true,
      treeShake: mode === "production",
    }),
    chuckerPlugin({
      subPackage: true,
      console: false,
      maxLogs: 150,
      enabled: true,
    }),
  ],
  build: {
    minify: mode === "production",
    cssMinify: mode === "production" ? "lightningcss" : false,
  },
}));
