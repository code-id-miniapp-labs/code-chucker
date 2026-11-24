import * as fs from "fs";
import * as path from "path";

export interface ChuckerVitePluginOptions {
  /**
   * Whether Chucker should be active.
   * Defaults to `true` when Vite mode or `NODE_ENV` is `"development"`, `false` otherwise.
   */
  enabled?: boolean;
  /**
   * Register the inspector page as an independent sub-package instead of a
   * main-package page, so its UI code does not count toward the main package size.
   * - `true` (default): sub-package root "chucker"  → route "/chucker/index"
   * - `string`: custom sub-package root             → route "/<root>/index"
   * - `false`: legacy behaviour, main-package page  → route "/pages/chucker/index"
   */
  subPackage?: boolean | string;
  /**
   * Maximum number of log entries to keep in memory.
   * Forwarded to `initChucker({ maxLogs })`.
   * @default 100
   */
  maxLogs?: number;
  /**
   * Patch `console.log`, `console.warn`, `console.error` to capture logs in Chucker.
   * Forwarded to `initChucker({ console })`.
   * @default false
   */
  console?: boolean;
  /**
   * Override the Mini Program source root directory (relative to Vite `root`).
   * Automatically reads `weapp.srcRoot` from `vite.config.ts` when omitted, falling back to `"src"`.
   */
  srcRoot?: string;
}

/** Minimal structural Vite/Rollup plugin types so this package does not require Vite at compile time. */
export interface ViteOutputAsset {
  type: "asset";
  fileName: string;
  source: string | Uint8Array;
}

export interface ViteOutputChunk {
  type: "chunk";
  fileName: string;
  code: string;
}

export type ViteOutputBundle = Record<string, ViteOutputAsset | ViteOutputChunk>;

export interface VitePluginContext {
  emitFile(emittedFile: { type: "asset"; fileName: string; source: string | Uint8Array }): string;
}

export interface ViteResolvedConfig {
  root: string;
  mode: string;
  weapp?: {
    srcRoot?: string;
  };
}

export interface VitePlugin {
  name: string;
  enforce?: "pre" | "post";
  config?: (
    userConfig: Record<string, any>,
    env: { mode: string; command: string },
  ) => Record<string, any> | void;
  configResolved?: (config: ViteResolvedConfig) => void;
  transform?: (code: string, id: string) => { code: string; map: null } | null | void;
  generateBundle?: {
    order?: "pre" | "post";
    handler: (
      this: VitePluginContext,
      outputOptions: Record<string, any>,
      bundle: ViteOutputBundle,
    ) => void;
  };
}

interface LayoutInfo {
  isSub: boolean;
  root: string;
  pagePath: string;
}

const APP_ENTRY_NAMES = ["app.ts", "app.tsx", "app.js", "app.jsx", "app.mjs"];
const COMPONENT_DIST_PATH = "components/chucker-float";
const COMPONENT_FILES = ["index.js", "index.json", "index.wxml", "index.wxss"];
const PAGE_EXTENSIONS = [".js", ".json", ".wxml", ".wxss"];
const TEMPLATE_EXT_RE = /\.(wxml|axml|ttml|swan|qml)$/;

function resolveLayout(options: ChuckerVitePluginOptions): LayoutInfo {
  const sp = options.subPackage === undefined ? true : options.subPackage;
  if (sp === false) {
    return { isSub: false, root: "", pagePath: "pages/chucker/index" };
  }
  const root =
    typeof sp === "string" && sp.trim() ? sp.trim().replace(/^\/+|\/+$/g, "") : "chucker";
  return { isSub: true, root, pagePath: `${root}/index` };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isEnabledForMode(options: ChuckerVitePluginOptions, mode?: string): boolean {
  if (options.enabled !== undefined) return options.enabled;
  return mode === "development" || process.env.NODE_ENV === "development";
}

function findAppEntryFiles(projectRoot: string, srcRootOption?: string): Set<string> {
  const candidates = new Set<string>();
  const searchDirs: string[] = [];

  if (srcRootOption) {
    searchDirs.push(path.resolve(projectRoot, srcRootOption));
  } else {
    searchDirs.push(path.resolve(projectRoot, "src"));
    searchDirs.push(path.resolve(projectRoot));
  }

  for (const dir of searchDirs) {
    for (const file of APP_ENTRY_NAMES) {
      const fullPath = path.join(dir, file);
      if (fs.existsSync(fullPath)) {
        candidates.add(normalizePath(path.resolve(fullPath)));
      }
    }
    if (candidates.size > 0) break;
  }

  // Fallback: if no file exists on disk yet (e.g. virtual/in-memory builds), register expected paths
  if (candidates.size === 0) {
    for (const dir of searchDirs) {
      for (const file of APP_ENTRY_NAMES) {
        candidates.add(normalizePath(path.resolve(dir, file)));
      }
    }
  }

  return candidates;
}

function readAssetText(asset: ViteOutputAsset): string {
  return typeof asset.source === "string"
    ? asset.source
    : Buffer.from(asset.source).toString("utf-8");
}

function collectUserPages(appConfig: Record<string, any>, layout: LayoutInfo): Set<string> {
  const pages = new Set<string>();
  const isChuckerPage = (pagePath: string) =>
    pagePath === layout.pagePath ||
    pagePath === "pages/chucker/index" ||
    pagePath.startsWith("pages/chucker/");

  if (Array.isArray(appConfig.pages)) {
    for (const p of appConfig.pages) {
      if (typeof p === "string" && !isChuckerPage(p)) {
        pages.add(p.replace(/^\/+/, ""));
      }
    }
  }

  for (const key of ["subPackages", "subpackages"]) {
    const list = appConfig[key];
    if (!Array.isArray(list)) continue;
    for (const pkg of list) {
      if (!pkg || typeof pkg.root !== "string" || !Array.isArray(pkg.pages)) continue;
      const root = pkg.root.replace(/^\/+|\/+$/g, "");
      if (layout.isSub && root === layout.root) continue;
      for (const p of pkg.pages) {
        if (typeof p !== "string") continue;
        const full = `${root}/${p.replace(/^\/+/, "")}`;
        if (!isChuckerPage(full)) {
          pages.add(full);
        }
      }
    }
  }

  return pages;
}

function isChuckerAsset(filename: string, layout: LayoutInfo): boolean {
  return (
    filename === layout.pagePath ||
    filename.startsWith(`${layout.pagePath}.`) ||
    filename.includes("pages/chucker/") ||
    filename.startsWith(`${COMPONENT_DIST_PATH}/`)
  );
}

/**
 * Vite / weapp-vite plugin for miniapp-chucker.
 *
 * Automatically:
 * 1. Injects `initChucker()` into the Mini Program `app.ts` / `app.js` entry
 * 2. Emits the native Chucker inspector page (as a sub-package by default) and `<chucker-float />` component
 * 3. Registers the inspector route and floating button in `app.json` and page JSON configs
 * 4. Injects `<chucker-float />` into all compiled page WXML templates
 */
export function chuckerPlugin(options: ChuckerVitePluginOptions = {}): VitePlugin {
  const layout = resolveLayout(options);
  let enabled = isEnabledForMode(options);
  let appEntryFiles = new Set<string>();

  return {
    name: "vite-plugin-chucker",
    enforce: "post",

    config(_userConfig, env) {
      enabled = isEnabledForMode(options, env?.mode);

      const define: Record<string, string> = {
        "process.env.CHUCKER_ENABLED": JSON.stringify(enabled),
        "process.env.CHUCKER_ROUTE": JSON.stringify("/" + layout.pagePath),
      };

      if (!enabled) {
        return { define };
      }

      const alias: Array<{ find: RegExp; replacement: string }> = [];
      try {
        const miniappChuckerPath = require.resolve("@code-id-labs/miniapp-chucker");
        alias.push({
          find: /^@code-id-labs\/miniapp-chucker$/,
          replacement: miniappChuckerPath,
        });
      } catch (_e) {
        // Host project may resolve @code-id-labs/miniapp-chucker directly
      }

      return {
        define,
        ...(alias.length > 0 ? { resolve: { alias } } : {}),
      };
    },

    configResolved(config) {
      enabled = isEnabledForMode(options, config.mode);
      if (!enabled) return;

      const srcRoot = options.srcRoot ?? config.weapp?.srcRoot;
      appEntryFiles = findAppEntryFiles(config.root, srcRoot);
    },

    transform(code, id) {
      if (!enabled) return null;
      if (id.includes("?")) return null;

      const cleanId = normalizePath(path.resolve(id));
      if (!appEntryFiles.has(cleanId)) return null;

      // Avoid double injection if user already calls initChucker manually
      if (code.includes("initChucker")) return null;

      const initOpts: Record<string, unknown> = {
        navigatePath: "/" + layout.pagePath,
      };
      if (options.maxLogs !== undefined) initOpts.maxLogs = options.maxLogs;
      if (options.console !== undefined) initOpts.console = options.console;

      const injection =
        `import { initChucker } from "@code-id-labs/miniapp-chucker";\n` +
        `try {\n` +
        `  initChucker(${JSON.stringify(initOpts)});\n` +
        `} catch (e) {\n` +
        `  console.error("[miniapp-chucker] Auto-initialization error:", e);\n` +
        `}\n`;

      return {
        code: injection + code,
        map: null,
      };
    },

    generateBundle: {
      order: "post",
      handler(_outputOptions, bundle) {
        if (!enabled) return;

        // 1. Emit the <chucker-float /> custom component files
        const componentSrcDir = path.resolve(__dirname, "components", "chucker-float");
        for (const file of COMPONENT_FILES) {
          const srcFile = path.join(componentSrcDir, file);
          const distKey = `${COMPONENT_DIST_PATH}/${file}`;
          if (fs.existsSync(srcFile) && !bundle[distKey]) {
            this.emitFile({
              type: "asset",
              fileName: distKey,
              source: fs.readFileSync(srcFile, "utf-8"),
            });
          }
        }

        // 2. Emit the native Chucker inspector page files (sub-package or main-package)
        const pageSrcDir = path.resolve(__dirname, "pages", "chucker");
        for (const ext of PAGE_EXTENSIONS) {
          const srcFile = path.join(pageSrcDir, `index${ext}`);
          const distKey = `${layout.pagePath}${ext}`;
          if (fs.existsSync(srcFile) && !bundle[distKey]) {
            this.emitFile({
              type: "asset",
              fileName: distKey,
              source: fs.readFileSync(srcFile, "utf-8"),
            });
          }
        }

        // 3. Patch app.json: register inspector route/sub-package and global usingComponents
        let userPages = new Set<string>();
        const appJsonAsset = bundle["app.json"];
        if (appJsonAsset && appJsonAsset.type === "asset") {
          try {
            const cfg = JSON.parse(readAssetText(appJsonAsset));
            userPages = collectUserPages(cfg, layout);

            if (!layout.isSub) {
              if (!Array.isArray(cfg.pages)) cfg.pages = [];
              if (!cfg.pages.includes(layout.pagePath)) {
                cfg.pages.push(layout.pagePath);
                console.log(
                  `[vite-plugin-chucker] Registered main-package page "${layout.pagePath}"`,
                );
              }
            } else {
              const key =
                Array.isArray(cfg.subpackages) && !Array.isArray(cfg.subPackages)
                  ? "subpackages"
                  : "subPackages";
              if (!Array.isArray(cfg[key])) cfg[key] = [];
              const existing = cfg[key].find((p: any) => p && p.root === layout.root);
              if (!existing) {
                cfg[key].push({ root: layout.root, pages: ["index"] });
                console.log(
                  `[vite-plugin-chucker] Registered sub-package "${layout.root}" (route "/${layout.pagePath}")`,
                );
              } else if (!Array.isArray(existing.pages) || !existing.pages.includes("index")) {
                existing.pages = [...(existing.pages || []), "index"];
              }
              if (Array.isArray(cfg.pages)) {
                cfg.pages = cfg.pages.filter((p: string) => p !== "pages/chucker/index");
              }
            }

            if (!cfg.usingComponents) cfg.usingComponents = {};
            if (!cfg.usingComponents["chucker-float"]) {
              cfg.usingComponents["chucker-float"] = `/${COMPONENT_DIST_PATH}/index`;
            }

            appJsonAsset.source = JSON.stringify(cfg);
          } catch (err) {
            console.error("[vite-plugin-chucker] Failed to patch app.json:", err);
          }
        }

        // 4. Patch page JSON configs & inject <chucker-float /> into page templates
        for (const filename of Object.keys(bundle)) {
          const item = bundle[filename];
          if (!item || item.type !== "asset") continue;
          if (isChuckerAsset(filename, layout)) continue;

          // Page JSON config
          if (filename.endsWith(".json") && filename !== "app.json") {
            const pageBase = filename.slice(0, -".json".length);
            const isTargetPage =
              userPages.size > 0 ? userPages.has(pageBase) : filename.startsWith("pages/");

            if (isTargetPage) {
              try {
                const config = JSON.parse(readAssetText(item));
                if (!config.usingComponents) config.usingComponents = {};
                if (!config.usingComponents["chucker-float"]) {
                  config.usingComponents["chucker-float"] = `/${COMPONENT_DIST_PATH}/index`;
                  item.source = JSON.stringify(config);
                }
              } catch (err) {
                console.error("[vite-plugin-chucker] Failed to patch page JSON:", filename, err);
              }
            }
            continue;
          }

          // Page WXML / template
          if (TEMPLATE_EXT_RE.test(filename)) {
            const pageBase = filename.replace(TEMPLATE_EXT_RE, "");
            const isTargetPage =
              userPages.size > 0 ? userPages.has(pageBase) : filename.startsWith("pages/");

            if (isTargetPage) {
              const content = readAssetText(item);
              if (!content.includes("chucker-float")) {
                item.source = `${content}\n<chucker-float url="/${layout.pagePath}" />\n`;
              }
            }
          }
        }
      },
    },
  };
}

export default chuckerPlugin;
