// Provisions the runtime assets the app serves from public/:
//   - MediaPipe's WASM runtime, copied out of node_modules
//   - the pose model, downloaded once
// Kept out of version control so the repo stays free of ~38MB of binaries.
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WASM_SRC = join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const WASM_DEST = join(root, 'public/wasm')
const MODELS = [
  {
    dest: join(root, 'public/models/pose_landmarker_lite.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  },
  {
    dest: join(root, 'public/models/hand_landmarker.task'),
    url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  },
]

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function copyWasm() {
  if (!(await exists(WASM_SRC))) {
    throw new Error('@mediapipe/tasks-vision not installed — run npm install first')
  }
  await mkdir(WASM_DEST, { recursive: true })
  const files = await readdir(WASM_SRC)
  await Promise.all(files.map((f) => copyFile(join(WASM_SRC, f), join(WASM_DEST, f))))
  console.log(`wasm: copied ${files.length} files`)
}

async function fetchModel({ dest, url }) {
  const name = dest.split('/').pop()
  if (await exists(dest)) {
    console.log(`${name}: already present`)
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name} download failed: HTTP ${res.status}`)
  await pipeline(res.body, createWriteStream(dest))
  const { size } = await stat(dest)
  console.log(`${name}: downloaded ${(size / 1e6).toFixed(1)} MB`)
}

await copyWasm()
for (const model of MODELS) await fetchModel(model)
