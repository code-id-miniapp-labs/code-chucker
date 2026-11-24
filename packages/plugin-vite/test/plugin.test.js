const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { chuckerPlugin } = require("../dist/index.js");

function createMockBundle() {
  return {
    "app.json": {
      type: "asset",
      fileName: "app.json",
      source: JSON.stringify({
        pages: ["pages/index/index", "pages/profile/index"],
        subPackages: [
          {
            root: "pkgA",
            pages: ["detail/index"],
          },
        ],
      }),
    },
    "pages/index/index.json": {
      type: "asset",
      fileName: "pages/index/index.json",
      source: JSON.stringify({ navigationBarTitleText: "Home" }),
    },
    "pages/index/index.wxml": {
      type: "asset",
      fileName: "pages/index/index.wxml",
      source: "<view>Home</view>",
    },
    "pages/profile/index.wxml": {
      type: "asset",
      fileName: "pages/profile/index.wxml",
      source: "<view>Profile</view>",
    },
    "pkgA/detail/index.json": {
      type: "asset",
      fileName: "pkgA/detail/index.json",
      source: JSON.stringify({}),
    },
    "pkgA/detail/index.wxml": {
      type: "asset",
      fileName: "pkgA/detail/index.wxml",
      source: "<view>Subpackage detail</view>",
    },
    "components/button/index.wxml": {
      type: "asset",
      fileName: "components/button/index.wxml",
      source: "<button>Click</button>",
    },
  };
}

function runGenerateBundle(plugin, bundle) {
  const emitted = {};
  const ctx = {
    emitFile(file) {
      emitted[file.fileName] = file.source;
      bundle[file.fileName] = {
        type: "asset",
        fileName: file.fileName,
        source: file.source,
      };
      return file.fileName;
    },
  };
  plugin.generateBundle.handler.call(ctx, {}, bundle);
  return emitted;
}

test("default sub-package mode registers subPackage, emits assets, and injects into pages", () => {
  const plugin = chuckerPlugin();
  const cfgResult = plugin.config({}, { mode: "development", command: "build" });
  assert.equal(cfgResult.define["process.env.CHUCKER_ENABLED"], "true");
  assert.equal(cfgResult.define["process.env.CHUCKER_ROUTE"], '"/chucker/index"');

  const projectRoot = "/mock/weapp-project";
  plugin.configResolved({
    root: projectRoot,
    mode: "development",
    weapp: { srcRoot: "src" },
  });

  // Transform injects initChucker into src/app.ts
  const appId = path.resolve(projectRoot, "src", "app.ts");
  const transformed = plugin.transform("App({});", appId);
  assert.ok(transformed);
  assert.match(transformed.code, /import \{ initChucker \} from "miniapp-chucker";/);
  assert.match(transformed.code, /"navigatePath":"\/chucker\/index"/);

  // Transform skips non-entry files and avoids double injection
  assert.equal(plugin.transform("Page({});", path.resolve(projectRoot, "src/pages/index/index.ts")), null);
  assert.equal(plugin.transform("initChucker(); App({});", appId), null);

  // generateBundle emits float component + sub-package page and patches bundle
  const bundle = createMockBundle();
  const emitted = runGenerateBundle(plugin, bundle);

  for (const file of ["index.js", "index.json", "index.wxml", "index.wxss"]) {
    assert.ok(emitted[`components/chucker-float/${file}`], `missing component ${file}`);
  }
  for (const ext of [".js", ".json", ".wxml", ".wxss"]) {
    assert.ok(emitted[`chucker/index${ext}`], `missing inspector page chucker/index${ext}`);
  }

  const appJson = JSON.parse(bundle["app.json"].source);
  assert.ok(
    appJson.subPackages.some((pkg) => pkg.root === "chucker" && pkg.pages.includes("index")),
    "app.json should register chucker sub-package",
  );
  assert.equal(appJson.usingComponents["chucker-float"], "/components/chucker-float/index");

  const indexJson = JSON.parse(bundle["pages/index/index.json"].source);
  assert.equal(indexJson.usingComponents["chucker-float"], "/components/chucker-float/index");

  assert.match(bundle["pages/index/index.wxml"].source, /<chucker-float url="\/chucker\/index" \/>/);
  assert.match(bundle["pages/profile/index.wxml"].source, /<chucker-float url="\/chucker\/index" \/>/);
  assert.match(bundle["pkgA/detail/index.wxml"].source, /<chucker-float url="\/chucker\/index" \/>/);
  // Regular components should NOT get <chucker-float /> injected
  assert.doesNotMatch(bundle["components/button/index.wxml"].source, /chucker-float/);
});

test("custom subPackage root and main-package mode", () => {
  // Custom sub-package root
  const customPlugin = chuckerPlugin({ enabled: true, subPackage: "/debug/chucker/" });
  customPlugin.configResolved({ root: "/mock/app", mode: "production" });
  const customBundle = createMockBundle();
  const customEmitted = runGenerateBundle(customPlugin, customBundle);

  assert.ok(customEmitted["debug/chucker/index.wxml"]);
  const customAppJson = JSON.parse(customBundle["app.json"].source);
  assert.ok(customAppJson.subPackages.some((p) => p.root === "debug/chucker"));
  assert.match(customBundle["pages/index/index.wxml"].source, /url="\/debug\/chucker\/index"/);

  // Legacy main-package mode
  const mainPlugin = chuckerPlugin({ enabled: true, subPackage: false });
  mainPlugin.configResolved({ root: "/mock/app", mode: "production" });
  const mainBundle = createMockBundle();
  const mainEmitted = runGenerateBundle(mainPlugin, mainBundle);

  assert.ok(mainEmitted["pages/chucker/index.wxml"]);
  const mainAppJson = JSON.parse(mainBundle["app.json"].source);
  assert.ok(mainAppJson.pages.includes("pages/chucker/index"));
  assert.match(mainBundle["pages/index/index.wxml"].source, /url="\/pages\/chucker\/index"/);
});

test("disabled mode in production is a complete no-op", () => {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const plugin = chuckerPlugin();
    const cfgResult = plugin.config({}, { mode: "production", command: "build" });
    assert.equal(cfgResult.define["process.env.CHUCKER_ENABLED"], "false");

    plugin.configResolved({ root: "/mock/app", mode: "production" });
    assert.equal(plugin.transform("App({});", "/mock/app/src/app.ts"), null);

    const bundle = createMockBundle();
    const origAppJson = bundle["app.json"].source;
    const origWxml = bundle["pages/index/index.wxml"].source;
    const emitted = runGenerateBundle(plugin, bundle);

    assert.deepEqual(Object.keys(emitted), []);
    assert.equal(bundle["app.json"].source, origAppJson);
    assert.equal(bundle["pages/index/index.wxml"].source, origWxml);
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});
