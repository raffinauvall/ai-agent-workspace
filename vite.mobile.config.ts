import { readFile, writeFile, unlink } from "node:fs/promises";
import { defineConfig, type Plugin } from "vite";

function inlineSceneScript(): Plugin {
  return {
    name: "inline-mobile-scene-script",
    async closeBundle() {
      const htmlPath = new URL("./mobile/assets/office_scene/index.html", import.meta.url);
      const scriptPath = new URL("./mobile/assets/office_scene/scene.js", import.meta.url);
      const [html, script] = await Promise.all([readFile(htmlPath, "utf8"), readFile(scriptPath, "utf8")]);
      const escapedScript = script.replace(/<\/script/gi, "<\\/script");
      const tag = '<script type="module" crossorigin src="./scene.js"></script>';
      if (!html.includes(tag)) throw new Error("Mobile scene script tag not found");
      const inlined = html.replace(tag, () => `<script type="module">${escapedScript}</script>`);
      await writeFile(htmlPath, inlined);
      // The WebView uses the inlined script; do not package it twice in the APK.
      await unlink(scriptPath);
    },
  };
}

export default defineConfig({
  assetsInclude: ["**/*.glb"],
  plugins: [inlineSceneScript()],
  root: "mobile_scene",
  base: "./",
  resolve: {
    alias: {
      $lib: new URL("./src/lib", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "../mobile/assets/office_scene",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "scene.js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
