import { createPoseLandmarker } from './landmarker'
import type { Landmark3 } from './angles'

/**
 * A pose track: the reference dancer's skeleton for a whole video, worked out
 * once and stored.
 *
 * Playback currently runs the pose model on the reference every frame, which is
 * half the compute in the app and the reason a phone cannot keep up. The
 * reference never changes, so paying for it repeatedly is waste. Analysing once
 * also lifts a constraint: nothing here is realtime, so the work can be slower
 * and steadier than live detection is allowed to be.
 */

const SAMPLE_FPS = 15
/** x, y, visibility for the drawn skeleton; x, y, z for the maths. */
const VALUES_PER_LANDMARK = 6
const LANDMARK_COUNT = 33
const STRIDE = LANDMARK_COUNT * VALUES_PER_LANDMARK

export interface PoseTrack {
  fps: number
  frames: number
  /** Packed, `frames * STRIDE` long. NaN marks a frame with no dancer. */
  data: Float32Array
}

export interface TrackFrame {
  /** Normalised image coordinates, for drawing. */
  landmarks: { x: number; y: number; z: number; visibility: number }[]
  /** Metric 3D, for the comparison. */
  world: Landmark3[]
}

/**
 * Walks the video and records the dancer.
 *
 * Seeking frame by frame is accurate but slow; playing the video and taking
 * whatever frames arrive is fast but skips. This plays at speed and samples on
 * a fixed grid of video time, which keeps the spacing predictable without
 * paying for thousands of seeks.
 */
export async function analyseVideo(
  blob: Blob,
  onProgress: (fraction: number) => void,
  shouldStop: () => boolean = () => false,
): Promise<PoseTrack | null> {
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.src = url
  video.muted = true
  video.playsInline = true

  const landmarker = await createPoseLandmarker(1)
  const canvas = document.createElement('canvas')

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('cannot decode'))
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration <= 0) return null

    const frames = Math.max(1, Math.ceil(duration * SAMPLE_FPS))
    const data = new Float32Array(frames * STRIDE).fill(NaN)
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')!

    let stamp = 0
    for (let i = 0; i < frames; i++) {
      if (shouldStop()) return null
      const t = Math.min(duration - 1e-3, i / SAMPLE_FPS)
      await seek(video, t)
      // Through a 2D canvas: a freshly seeked video can upload as an empty
      // frame to WebGL, which would silently record nothing.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const res = landmarker.detectForVideo(canvas, ++stamp)
      const lm = res.landmarks[0]
      const world = res.worldLandmarks[0]
      if (lm && world) {
        const base = i * STRIDE
        for (let k = 0; k < LANDMARK_COUNT; k++) {
          const o = base + k * VALUES_PER_LANDMARK
          data[o] = lm[k].x
          data[o + 1] = lm[k].y
          data[o + 2] = lm[k].visibility ?? 1
          data[o + 3] = world[k].x
          data[o + 4] = world[k].y
          data[o + 5] = world[k].z
        }
      }
      if (i % 8 === 0) {
        onProgress(i / frames)
        // Yield, or the page freezes for the whole analysis.
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    onProgress(1)
    return { fps: SAMPLE_FPS, frames, data }
  } finally {
    landmarker.close()
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
  }
}

function seek(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      video.removeEventListener('seeked', finish)
      resolve()
    }
    video.addEventListener('seeked', finish)
    video.currentTime = t
    // Never let one stubborn seek stall the whole analysis.
    setTimeout(finish, 400)
  })
}

const has = (track: PoseTrack, i: number) => !Number.isNaN(track.data[i * STRIDE])

/**
 * The dancer at a moment, interpolated between samples so the skeleton moves as
 * smoothly as the video does rather than at the sampling rate.
 */
export function sampleTrack(track: PoseTrack, time: number): TrackFrame | null {
  const exact = time * track.fps
  const i = Math.floor(exact)
  const j = Math.min(track.frames - 1, i + 1)
  if (i < 0 || i >= track.frames) return null
  if (!has(track, i)) return has(track, j) ? read(track, j, j, 0) : null
  return read(track, i, has(track, j) ? j : i, exact - i)
}

function read(track: PoseTrack, i: number, j: number, f: number): TrackFrame {
  const landmarks = []
  const world = []
  const a = i * STRIDE
  const b = j * STRIDE
  for (let k = 0; k < LANDMARK_COUNT; k++) {
    const oa = a + k * VALUES_PER_LANDMARK
    const ob = b + k * VALUES_PER_LANDMARK
    const mix = (p: number) => track.data[oa + p] + (track.data[ob + p] - track.data[oa + p]) * f
    landmarks.push({ x: mix(0), y: mix(1), z: 0, visibility: mix(2) })
    world.push({ x: mix(3), y: mix(4), z: mix(5), visibility: mix(2) })
  }
  return { landmarks, world }
}

export const packTrack = (t: PoseTrack): { fps: number; frames: number; buffer: ArrayBuffer } => ({
  fps: t.fps,
  frames: t.frames,
  buffer: t.data.buffer.slice(0) as ArrayBuffer,
})

export const unpackTrack = (p: { fps: number; frames: number; buffer: ArrayBuffer }): PoseTrack => ({
  fps: p.fps,
  frames: p.frames,
  data: new Float32Array(p.buffer),
})
