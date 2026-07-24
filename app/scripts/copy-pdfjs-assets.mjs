// Copies pdf.js wasm image decoders (qcms for ICC colors, openjpeg for JPX,
// jbig2) into public/ so the worker can fetch them at runtime — the bundler
// does not expose node_modules assets by URL. Runs via predev/prebuild.
import { cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const source = path.join(appDir, "node_modules", "pdfjs-dist", "wasm")
const target = path.join(appDir, "public", "pdfjs", "wasm")

await mkdir(path.dirname(target), { recursive: true })
await cp(source, target, { recursive: true })
console.log("pdf.js wasm assets copied to public/pdfjs/wasm")
