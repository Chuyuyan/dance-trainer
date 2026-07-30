import { useEffect, useRef, useState } from 'react'
import VideoPanel, { type TargetPose } from './components/VideoPanel'
import WebcamPanel from './components/WebcamPanel'
import { LEVEL_COLORS, SIDE_COLORS } from './pose/skeleton'

export default function App() {
  const [src, setSrc] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const targetRef = useRef<TargetPose>({ angles: null })

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [src])

  const loadFile = (file: File | undefined | null) => {
    if (!file) return
    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file')
      return
    }
    setSrc((old) => {
      if (old) URL.revokeObjectURL(old)
      return URL.createObjectURL(file)
    })
  }

  return (
    <div className="app">
      <header>
        <h1>
          Dance Trainer <span className="sub">Load any dance video and follow the outline</span>
        </h1>
        <label className="btn primary upload">
          {src ? 'Change video' : 'Load video'}
          <input type="file" accept="video/*" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
        </label>
      </header>

      <main className="panels">
        {src ? (
          <VideoPanel src={src} targetRef={targetRef} />
        ) : (
          <section
            className={`panel dropzone ${dragOver ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              loadFile(e.dataTransfer.files?.[0])
            }}
          >
            <div className="drop-inner">
              <p>Drop a dance video here, or load one from the top right</p>
              <p className="hint">
                Solo or group video · click a dancer to follow them · everything runs locally, nothing is
                uploaded
              </p>
            </div>
          </section>
        )}
        <WebcamPanel targetRef={targetRef} />
      </main>

      <footer>
        <span className="legend-group">
          <span className="legend-title">Reference</span>
          <span className="legend-item">
            <i style={{ background: SIDE_COLORS.left }} /> dancer&rsquo;s left
          </span>
          <span className="legend-item">
            <i style={{ background: SIDE_COLORS.right }} /> dancer&rsquo;s right
          </span>
          <span className="legend-item">
            <i style={{ background: SIDE_COLORS.center }} /> torso
          </span>
        </span>
        <span className="legend-group">
          <span className="legend-title">You</span>
          <span className="legend-item">
            <i style={{ background: LEVEL_COLORS.ok }} /> matching
          </span>
          <span className="legend-item">
            <i style={{ background: LEVEL_COLORS.warn }} /> a bit off
          </span>
          <span className="legend-item">
            <i style={{ background: LEVEL_COLORS.bad }} /> way off
          </span>
          <span className="legend-item">
            <i style={{ background: LEVEL_COLORS.na }} /> not compared
          </span>
        </span>
      </footer>
    </div>
  )
}
