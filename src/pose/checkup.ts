import { computeFeature, HEAD, type Landmark3, type PoseFeature } from './angles'
import { LM } from './skeleton'

/**
 * A guided accuracy check.
 *
 * Tuning a scorer on "it feels wrong" does not converge. These poses are
 * defined in code, so the correct answer is known before the camera is on:
 * whatever the score says can be compared against what the pose actually is.
 * They run easiest first, so a failure part-way through localises the problem
 * instead of just saying the thing is broken.
 */

type V = Landmark3
const P = (x: number, y: number, z: number): V => ({ x, y, z, visibility: 1 })

/** A neutral standing body; limbs get overwritten per pose. */
function base(): V[] {
  const lm = Array.from({ length: 33 }, () => P(0, 0, 0))
  lm[LM.lShoulder] = P(-0.18, -0.55, 0)
  lm[LM.rShoulder] = P(0.18, -0.55, 0)
  lm[LM.lHip] = P(-0.12, 0, 0)
  lm[LM.rHip] = P(0.12, 0, 0)
  lm[LM.lKnee] = P(-0.14, 0.45, 0)
  lm[LM.rKnee] = P(0.14, 0.45, 0)
  lm[LM.lAnkle] = P(-0.15, 0.9, 0)
  lm[LM.rAnkle] = P(0.15, 0.9, 0)
  lm[LM.nose] = P(0, -0.72, -0.09)
  lm[LM.lEar] = P(-0.07, -0.7, 0)
  lm[LM.rEar] = P(0.07, -0.7, 0)
  return lm
}

/** Places an arm by direction, in metres from the shoulder. */
function arm(lm: V[], side: 'l' | 'r', dir: [number, number, number]): void {
  const s = side === 'l' ? lm[LM.lShoulder] : lm[LM.rShoulder]
  const n = Math.hypot(...dir) || 1
  const [dx, dy, dz] = dir.map((d) => d / n)
  const put = (i: number, k: number) => {
    lm[i] = P(s.x + dx * k, s.y + dy * k, s.z + dz * k)
  }
  put(side === 'l' ? LM.lElbow : LM.rElbow, 0.26)
  put(side === 'l' ? LM.lWrist : LM.rWrist, 0.52)
}

export interface CheckPose {
  id: string
  /**
   * The feature keys this step is really about. The overall score is a poor
   * signal for a step that moves one limb — turning your head changes one of
   * nine numbers — so the report leads with these.
   */
  focus: string[]
  /** Shown to the dancer. Kept short enough to read while moving. */
  instruction: string
  /** What this step is actually testing, for the report. */
  tests: string
  landmarks: V[]
}

/** MediaPipe's y grows downward, so "up" is negative y. */
const CHECKS: CheckPose[] = [
  (() => {
    const lm = base()
    arm(lm, 'l', [-0.1, 1, 0])
    arm(lm, 'r', [0.1, 1, 0])
    return { id: 'rest', focus: ['lUpperArm', 'rUpperArm', 'lThigh', 'rThigh'], instruction: 'Stand still, arms hanging down', tests: 'baseline, and whether your legs are in frame', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-1, 0, 0])
    arm(lm, 'r', [1, 0, 0])
    return { id: 'tpose', focus: ['lUpperArm', 'rUpperArm', 'lForearm', 'rForearm'], instruction: 'Both arms straight out to the sides', tests: 'the easiest possible pose', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-0.1, -1, 0])
    arm(lm, 'r', [0.1, -1, 0])
    return { id: 'overhead', focus: ['lUpperArm', 'rUpperArm', 'lForearm', 'rForearm'], instruction: 'Both arms straight up overhead', tests: 'whether up and down are told apart', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-0.1, -1, 0])
    arm(lm, 'r', [1, 0, 0])
    return { id: 'asym', focus: ['lUpperArm', 'rUpperArm'], instruction: 'LEFT arm up, RIGHT arm out to the side', tests: 'left and right not being swapped', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [0, 0, -1])
    arm(lm, 'r', [0, 0, -1])
    return { id: 'forward', focus: ['lUpperArm', 'rUpperArm', 'lForearm', 'rForearm'], instruction: 'Both arms straight forward, towards the camera', tests: 'depth — the case flat 2D could not see', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-0.1, 1, 0])
    arm(lm, 'r', [0.1, 1, 0])
    // Head turned towards their own left.
    lm[LM.nose] = P(-0.06, -0.72, -0.05)
    return { id: 'head', focus: [HEAD], instruction: 'Arms down, turn your head to YOUR left', tests: 'head direction', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-1, 0, 0])
    arm(lm, 'r', [1, 0, 0])
    lm[LM.lKnee] = P(-0.16, 0.38, -0.1)
    lm[LM.rKnee] = P(0.16, 0.38, -0.1)
    lm[LM.lAnkle] = P(-0.15, 0.78, 0)
    lm[LM.rAnkle] = P(0.15, 0.78, 0)
    return { id: 'squat', focus: ['lThigh', 'rThigh', 'lShin', 'rShin'], instruction: 'Arms out, bend your knees a little', tests: 'the legs, which arms-only checks miss', landmarks: lm }
  })(),
  (() => {
    const lm = base()
    arm(lm, 'l', [-1, 0, 0])
    arm(lm, 'r', [1, 0, 0])
    return { id: 'turned', focus: ['lUpperArm', 'rUpperArm', 'lForearm', 'rForearm'], instruction: 'Arms out again, but turn your body 45° to one side', tests: 'whether standing at an angle still scores', landmarks: lm }
  })(),
]

export interface CheckStep extends CheckPose {
  target: PoseFeature
}

export const CHECK_STEPS: CheckStep[] = CHECKS.map((c) => ({ ...c, target: computeFeature(c.landmarks) }))

/**
 * Reasons the camera view itself would spoil a score, checked before blaming
 * the dancer. Returns an empty list when the framing is fine.
 */
export function framingProblems(
  lm: { x: number; y: number; visibility?: number }[],
  focus: 'full' | 'upper' | 'lower' = 'full',
): string[] {
  const out: string[] = []
  const seen = (i: number) => (lm[i]?.visibility ?? 0) >= 0.5
  const torso = seen(LM.lShoulder) && seen(LM.rShoulder) && seen(LM.lHip) && seen(LM.rHip)
  if (!torso) {
    out.push('Move back so your whole upper body is in frame')
    return out
  }
  // Nagging about feet while someone practises their arms is pure noise.
  if (focus !== 'upper' && (!seen(LM.lAnkle) || !seen(LM.rAnkle)))
    out.push('Your feet are out of frame, so leg movements are not scored')

  const ys = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].map((i) => lm[i].y)
  const xs = [LM.lShoulder, LM.rShoulder].map((i) => lm[i].x)
  const height = Math.max(...ys) - Math.min(...ys)
  if (height < 0.09) out.push('You look far away — come closer, or the tracking gets noisy')
  if (height > 0.55) out.push('You are very close — step back so more of you is visible')

  // Shoulders collapsing towards a point means the body is nearly edge-on.
  if (Math.abs(xs[0] - xs[1]) < 0.045) out.push('You are turned almost side-on, which the camera cannot read well')
  return out
}
