// Build DSSA's browser entry in the module format consumed by the DSH Web profile.
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createRequire } from "node:module"

const [toolsDir, source, output] = process.argv.slice(2)
const { build } = createRequire(resolve(toolsDir, "package.json"))("esbuild")
await build({
  entryPoints: [resolve(source, "src/client/index.tsx")],
  outfile: output,
  bundle: true,
  platform: "browser",
  format: "cjs",
  jsx: "automatic",
  external: ["react", "react/*", "react-dom", "react-dom/*"],
  nodePaths: [resolve(toolsDir, "node_modules")],
  plugins: [{
    name: "raw-styles",
    setup(builder) {
      builder.onResolve({ filter: /\?raw$/ }, args => ({
        path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "raw",
      }))
      builder.onLoad({ filter: /.*/, namespace: "raw" }, async ({path}) => ({
        contents: await readFile(path, "utf8"), loader: "text",
      }))
    },
  }],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-superagent",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
})
