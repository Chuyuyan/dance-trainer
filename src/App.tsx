import { useCallback, useEffect, useRef, useState } from 'react'
import VideoPanel, { type TargetPose } from './components/VideoPanel'
import WebcamPanel from './components/WebcamPanel'
import AccountBar from './components/AccountBar'
import Library from './components/Library'
import { LEVEL_COLORS, SIDE_COLORS } from './pose/skeleton'
import {
  forget,
  getVideo,
  listLibrary,
  mergeRemote,
  remember,
  touch,
  type LibraryEntry,
} from './lib/library'
import {
  loadLibraryIndex,
  loadSessions,
  onAuthChange,
  statsByVideo,
  syncLibrary,
  type VideoStats,
} from './playkitClient'

export default function App() {
  const [src, setSrc] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [library, setLibrary] = useState<LibraryEntry[]>([])
  const [stats, setStats] = useState<Map<string, VideoStats>>(new Map())
  const [current, setCurrent] = useState<LibraryEntry | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const targetRef = useRef<TargetPose>({ angles: null, history: [], time: 0, facing: null })
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src)
    }
  }, [src])

  const refresh = useCallback(async () => {
    setLibrary(await listLibrary())
  }, [])

  /** Reconciles this device with the account, in both directions. */
  const syncFromAccount = useCallback(async () => {
    // Push first. Most people play for a while and only sign up once they like
    // it, so by the time an account exists the library already has entries in
    // it — and pulling alone would silently strand every one of them on this
    // device. syncLibrary is a no-op while signed out.
    const local = await listLibrary()
    if (local.length) {
      await syncLibrary(
        local.map((e) => ({
          id: e.id,
          name: e.name,
          duration: e.duration,
          lastOpenedAt: e.lastOpenedAt,
        })),
      )
    }

    const [sessions, remote] = await Promise.all([loadSessions(), loadLibraryIndex()])
    setStats(statsByVideo(sessions))
    if (remote.length) {
      await mergeRemote(remote)
      await refresh()
    }
  }, [refresh])

  useEffect(() => {
    void refresh()
    void syncFromAccount()
    return onAuthChange(() => void syncFromAccount())
  }, [refresh, syncFromAccount])

  const play = (blob: Blob) => {
    setSrc((old) => {
      if (old) URL.revokeObjectURL(old)
      return URL.createObjectURL(blob)
    })
  }

  const loadFile = async (file: File | undefined | null) => {
    if (!file) return
    if (!file.type.startsWith('video/')) {
      alert('Please choose a video file')
      return
    }
    play(file)
    setLibraryOpen(false)
    const entry = await remember(file)
    setCurrent(entry)
    await refresh()
    if (entry) {
      void syncLibrary([
        { id: entry.id, name: entry.name, duration: entry.duration, lastOpenedAt: entry.lastOpenedAt },
      ])
    }
  }

  const openEntry = async (entry: LibraryEntry) => {
    const blob = await getVideo(entry.id)
    if (!blob) {
      // The record survived but the file did not — the only way back is for the
      // browser to hand us the file again.
      fileInputRef.current?.click()
      return
    }
    play(blob)
    setCurrent(entry)
    setLibraryOpen(false)
    await touch(entry.id)
    await refresh()
  }

  const forgetEntry = async (entry: LibraryEntry) => {
    await forget(entry.id)
    if (current?.id === entry.id) setCurrent(null)
    await refresh()
  }

  return (
    <div className="app">
      <header>
        <h1>
          Dance Trainer <span className="sub">Load any dance video and follow the outline</span>
        </h1>
        {library.length > 0 && (
          <button
            className={`btn ${libraryOpen ? 'active' : ''}`}
            onClick={() => setLibraryOpen(!libraryOpen)}
            title="Dances you have opened before"
          >
            Library ({library.length})
          </button>
        )}
        <label className="btn primary upload">
          {src ? 'Change video' : 'Load video'}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              void loadFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        <AccountBar />
      </header>

      {libraryOpen && library.length > 0 && (
        <section className="library-panel">
          <Library
            entries={library}
            stats={stats}
            currentId={current?.id ?? null}
            onOpen={(e) => void openEntry(e)}
            onForget={(e) => void forgetEntry(e)}
          />
          <p className="hint library-note">
            Videos are kept on this device only. Signed in, the list and your practice totals follow
            you; the footage does not.
          </p>
        </section>
      )}

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
              void loadFile(e.dataTransfer.files?.[0])
            }}
          >
            <div className="drop-inner">
              <p>Drop a dance video here, or load one from the top right</p>
              <p className="hint">
                Solo or group video · click a dancer to follow them · pose detection runs locally, your
                video is never uploaded
              </p>
              <Library
                entries={library}
                stats={stats}
                currentId={current?.id ?? null}
                onOpen={(e) => void openEntry(e)}
                onForget={(e) => void forgetEntry(e)}
              />
            </div>
          </section>
        )}
        <WebcamPanel
          targetRef={targetRef}
          videoId={current?.id}
          videoName={current?.name}
        />
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
