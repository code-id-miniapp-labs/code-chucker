# vite-plugin-chucker

Vite / `weapp-vite` build plugin for [`miniapp-chucker`](../chucker) — automatically injects the Chucker network & native API inspector into `weapp-vite` Mini Program projects.

## Installation

```bash
pnpm add vite-plugin-chucker -D
# or
npm install vite-plugin-chucker --save-dev
```

## Usage (`vite.config.ts`)

```ts
import { defineConfig } from "weapp-vite/config";
import chuckerPlugin from "vite-plugin-chucker";

export default defineConfig({
  weapp: {
    srcRoot: "src",
  },
  plugins: [
    chuckerPlugin({
      // Enabled automatically in development mode; set true/false to override
      // enabled: true,
      // Sub-package mode is enabled by default (route "/chucker/index")
      // subPackage: true,
      // subPackage: "debug/chucker", // custom sub-package root
      // subPackage: false,           // legacy main-package route "/pages/chucker/index"
      // maxLogs: 100,
      // console: false,
    }),
  ],
});
```

## What It Does

During build (when enabled):
1. Prepends `initChucker()` to your Mini Program entry (`src/app.ts` / `src/app.js`).
2. Emits the `<chucker-float />` custom component to `components/chucker-float/`.
3. Emits the native Chucker inspector page to `chucker/index` (sub-package by default) or `pages/chucker/index` (`subPackage: false`).
4. Registers the route and `chucker-float` in `app.json` and page JSON configs.
5. Injects `<chucker-float url="/..." />` into all compiled page templates (`.wxml`, `.axml`, `.ttml`, `.swan`, `.qml`).

When disabled (e.g. production builds), the plugin is a complete no-op with zero bundle overhead.

## Custom Event Logging

```ts
import { chuckerStore } from "vite-plugin-chucker/runtime";

chuckerStore.log({
  type: "websocket",
  method: "MESSAGE",
  url: "wss://api.example.com/ws",
  requestData: { event: "ping" },
  status: "success",
  responseData: { event: "pong" },
});
```
