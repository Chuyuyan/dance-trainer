# Dance Trainer

Turn any dance video into a practice room: skeleton overlay, mirror, slow motion, A-B loop, and a webcam view that shows you where you are off.

Video and webcam frames are processed **entirely in the browser** — neither your video nor your camera feed is ever uploaded. By default the app makes no requests to any server of mine at all.

Accounts are optional and off by default (see [Accounts](#accounts-optional)); when enabled, the only thing stored is aggregate practice numbers — how long you practised and how closely you matched.

## What it does

**Reference panel**

- Load (or drop in) any video; the dancer's skeleton is extracted per frame and drawn over it
- **Left and right limbs in different colours** — the dancer's left side cyan, right side orange, torso neutral, so it is obvious which leg is moving
- Mirror, so you do not have to flip left and right in your head
- 0.25x / 0.5x / 0.75x / 1x playback
- A-B loop, for drilling one eight-count
- *Outline only* dims the footage and leaves the skeleton, which makes lines and travel easier to read
- *Zoom*, three settings:
  - **Off** — the whole frame
  - **Fit** (recommended) — settles on a framing and then holds it
  - **Follow** — keeps the dancer centred, for footage where they travel
- Group video: click a dancer to lock onto them
- *Fingers* — overlays a 21-point hand skeleton (off by default, see below)

**You panel**

- Your skeleton, live from the webcam
- Compared with the reference frame by frame **by joint angle**, with the skeleton coloured by how far off each joint is: green matching, yellow a bit off, red way off, grey not compared
- A smoothed match score, plus a prompt naming the joints that are furthest off
- This side deliberately does **not** colour by left and right. Colour is spent on the more useful signal, and two colour languages on one skeleton would collide.

## Running it

```bash
npm install   # also runs npm run setup, which fetches the models and WASM
npm run dev
```

`npm run setup` copies MediaPipe's WASM runtime out of `node_modules` into `public/wasm` and downloads the pose and hand models into `public/models` (about 38 MB, kept out of version control). After that it runs offline.

## How it works

**Pose estimation** — MediaPipe Tasks Vision `pose_landmarker_lite`, BlazePose's 33 landmarks, GPU delegate with an automatic CPU fallback. All inference runs in the browser.

**Why joint angles rather than coordinates** — bodies, positions and camera distances all differ, so comparing coordinates is meaningless. Comparing the angles at eight joints (both elbows, shoulders, hips and knees) is naturally invariant to translation and scale.

**Angles need an aspect correction** — landmarks are normalised per axis, so x is squashed by the frame's aspect ratio. The video and the webcam rarely share an aspect ratio, so without correcting for it the two sides' angles are computed in differently distorted spaces and the comparison carries a systematic bias. `computeAngles` scales x back into units of frame height.

### Picking a dancer in a group video: crop and track

The main piece of engineering here.

Measured behaviour, identical across the lite, full and heavy models: when two people are **similar in size**, `numPoses > 1` finds both; as soon as one is noticeably smaller, BlazePose's person detector reports only the dominant one, and lowering the confidence thresholds does not help. Whole-frame detection plus a click test therefore cannot select a secondary dancer at all.

So it does what practical multi-person systems do — detect, crop, then single-person pose:

1. A click runs one whole-frame detection. That pose is used **only if the click actually landed on it** (`poseHit`); otherwise a default-sized box is opened at the click point. This step matters: `pickPose` returns the nearest pose however far away it is, so without the hit test, clicking a dancer the detector cannot see snaps the selection onto the one it can.
2. Every frame after that, only this box — square, so nothing is stretched — is scaled to 384x384 and run through the model as a single pose.
3. The landmarks are projected back into whole-frame normalised coordinates (`unproject`) for drawing and angle maths.
4. The box eases along with the dancer. If detection fails it widens gradually, and after 20 lost frames the lock is dropped and whole-frame tracking resumes.

Cropped, the subject fills the frame, so small dancers are detected reliably and with better precision.

### Zoom is a display-layer transform, and the hard part is holding still

Work out the largest scale the dancer still fits in, then use a CSS transform to scale and pan the video and the overlay together.

The first version took the **current frame's** bounding box as the target, and shook constantly. The cause is structural rather than numerical: the box widens when the dancer extends an arm and narrows when they pull it in, so the shot breathes — and the more it is zoomed, the more that wobble is amplified on screen, multiplied by the scale. Zooming as far as possible is itself what produces the shake.

What it does now:

- **Fit: watch briefly, commit to a framing, then freeze.** For the first 1.5 seconds the bounding boxes are accumulated into a union; once that settles, 8% of headroom is added and the framing is **fixed**. After that it does not move at all unless the dancer would actually be clipped, in which case it expands once and freezes again. To stop a single misdetection widening the shot permanently, frames whose box balloons past 3x the current area are discarded.

  The first attempt did the union and a deadband but no freeze — and the union keeps growing as the dancer moves, nudging the shot every time it does, so it **still moved**. That is the difference between "mostly still" and actually still; only freezing counts.

  The warm-up is measured in **wall-clock time, not frames**. A frame count drags on for seconds on a slow machine or a background tab, leaving the shot drifting the whole time.

- **Follow** smooths the box heavily (EMA), so the centre tracks the dancer while the size barely responds to arms opening and closing.

- **Both modes share a deadband**: scale changes under 5% and pans under 8px are ignored. This is what "not shaking" rests on. Without it the shot is continuously making small corrections, which reads as jitter.

- **The cap is 2.5x.** Past that the source has no more detail to give and it only magnifies blur.

- **A dropped pose no longer snaps back.** A missed detection used to reset the target to 1x and jolt the picture; now the last framing is kept.

Measured on a clip where the dancer drifts about 110px side to side, looping: after freezing, the framing takes **exactly one value** and never moves; the three changes before that are the initial push-in. Follow, on the same clip, changes three times, with scale steady at 2.4-2.5 and only the pan tracking the dancer.

Three smaller points:

1. The transform goes on **a single container wrapping both the video and the canvas**, so they scale together and the overlay never drifts out of register.
2. Each frame eases toward the target, and the pan is **clamped** so the frame always covers the stage and never pans into the void.
3. The transform is written straight to the DOM (`style.transform`) rather than through React state. It runs every frame, and a re-render per frame would be wasteful.

Because it is a uniform scale and pan, the click-to-select coordinate mapping keeps working with no extra inverse maths — clicking the centre of a zoomed-in stage still locks on correctly.

Note that **zoom depends on someone already being detected**. In a wide shot where the dancer is too small, whole-frame detection fails anyway; clicking them first, which takes the crop-and-track path, gets you both the skeleton and the zoom.

### Fingers: also cropped, and anchored to the wrist

Running HandLandmarker on the whole frame does not work. Hands are small in dance footage, and at thresholds low enough to find them the model starts reporting **feet as hands**. That is not hypothetical: it reported a wrist at y=0.805, down at the ankles, and drew a complete hand there.

The fix is not more threshold tuning but removing the possibility. Take the wrist and elbow the pose already found, open a box just past the wrist — hands extend away from the elbow — sized off shoulder width, and look for a hand only inside it. That rules out the foot-as-hand failure entirely, and hands the model a subject that fills the frame. One landmarker per hand, so the colour comes from the side directly and handedness never has to be guessed.

It costs two extra inference passes per frame, so it is a toggle, off by default.

**Separate landmarker instances** — a VIDEO-mode tracker carries internal state across frames, so feeding one instance different framings corrupts its predictions, visibly, as a scrambled skeleton. Whole-frame pose, cropped pose, left hand and right hand each get their own instance, each with its own monotonically increasing timestamps.

### Things that bite

- A paused or freshly seeked `<video>` can upload as an empty frame to WebGL. Draw it to a 2D canvas first.
- A paused video produces no new frames to drive detection, so switching the locked dancer has to force a few extra passes, or the screen stays stuck on the tracker's warm-up result.
- `object-fit: contain` letterboxes the canvas. Click coordinates must have the bars subtracted before normalising, or every click lands offset.
- webm recorded by MediaRecorder reports `duration` as `Infinity` until it has played.

## Known limits

- In a group video, dancers who overlap heavily or swap places can send the lock to the wrong person. Click again to fix it.
- The score reads eight joints in two dimensions only. It has no wrist orientation, body facing or depth, so side-on and turning movements are judged loosely.
- Scoring is frame by frame with no time alignment (DTW), so being off the beat is counted as being off the move.
- Fingers are shown on the Reference side only and **do not affect the score** — there are no finger terms in the angle comparison. Fast hand movement drops frames, and hands that are occluded or motion-blurred are simply not found.
- The left and right colours are the **dancer's own** left and right. With Mirror on, their left hand appears on your right, which is the point of mirroring: move the limb on the same side of the screen.

## Possible next steps

- DTW time alignment, to separate "off the beat" from "wrong move"
- Overlaying your skeleton directly on the reference skeleton, which is more informative than a score
- Per-section practice history: which eight-counts keep going wrong

## Accounts (optional)

Out of the box nothing is stored anywhere — close the tab and the session is gone.

To keep a practice history across devices, point the app at a
[playkit](https://github.com/Chuyuyan/playkit) server:

```sh
echo "VITE_PLAYKIT_URL=https://your-playkit-host" > .env.local
```

Signed-in dancers get each camera-on session (longer than 10 seconds) recorded
as duration, average match, and best match, with a running summary in the
header. Signed-out dancers get the original behaviour exactly.

There is deliberately **no leaderboard**: everyone practises a different video,
so comparing your match score to someone else's would be meaningless.

Only those aggregate numbers are transmitted. Pose detection, video, and camera
frames stay on your machine.

## Stack

React 19, TypeScript, Vite, MediaPipe Tasks Vision, Canvas 2D. No backend.
