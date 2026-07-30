import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision'

let visionPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null

function getVision() {
  visionPromise ??= FilesetResolver.forVisionTasks(import.meta.env.BASE_URL + 'wasm')
  return visionPromise
}

export async function createPoseLandmarker(numPoses: number): Promise<PoseLandmarker> {
  const vision = await getVision()
  const options = {
    baseOptions: {
      modelAssetPath: import.meta.env.BASE_URL + 'models/pose_landmarker_lite.task',
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    numPoses,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  }
  try {
    return await PoseLandmarker.createFromOptions(vision, options)
  } catch {
    // Some browsers/GPUs fail on the GPU delegate; CPU is slower but always works.
    return await PoseLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    })
  }
}

export async function createHandLandmarker(numHands: number): Promise<HandLandmarker> {
  const vision = await getVision()
  const options = {
    baseOptions: {
      modelAssetPath: import.meta.env.BASE_URL + 'models/hand_landmarker.task',
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    numHands,
    // Hands in a wide dance shot are small; the defaults miss most of them.
    minHandDetectionConfidence: 0.3,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  }
  try {
    return await HandLandmarker.createFromOptions(vision, options)
  } catch {
    return await HandLandmarker.createFromOptions(vision, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    })
  }
}
