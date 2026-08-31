import { History, Pause, Play, Sparkles, Video, VideoOff, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isDirectorActive } from '../../services/directorStatus'
import type { DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'

type GameStageProps = {
  session: GameSession | null
  hasApiKey: boolean
  directorStatus: DirectorStatus
  videoGenerationEnabled: boolean
  onStart: () => void
  onToggleVideoGeneration: (next: boolean) => void
  onRetryVideo?: (sceneId: string) => void
}

const TYPEWRITER_CHARS_PER_SECOND = 40
const FOLLOW_SCROLL_THRESHOLD = 56

const getStatus = (session: GameSession | null, directorStatus: DirectorStatus) => {
  if (!session) return ['等待开始', ''] as const
  if (session.status === 'awaiting_agent') {
    return isDirectorActive(directorStatus)
      ? ['导演续写中', 'busy'] as const
      : ['续写待恢复', 'error'] as const
  }
  return ['等待选择', ''] as const
}

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

export function GameStage(props: GameStageProps) {
  const {
    session, hasApiKey, directorStatus, videoGenerationEnabled,
    onStart, onToggleVideoGeneration, onRetryVideo,
  } = props
  const [reviewSceneId, setReviewSceneId] = useState('')
  const currentScene = session?.currentScene
  const scene = session?.sceneHistory.find((item) => item.id === reviewSceneId) ?? currentScene
  const sceneIndex = session?.sceneHistory.findIndex((item) => item.id === scene?.id) ?? -1
  const isReviewing = Boolean(scene && currentScene && scene.id !== currentScene.id)
  const [liveStatusLabel, liveStatusClass] = getStatus(session, directorStatus)
  const statusLabel = isReviewing ? `回看第 ${sceneIndex + 1} 幕` : liveStatusLabel
  const statusClass = isReviewing ? 'reviewing' : liveStatusClass

  // 打字进度带上场景 id，换幕时自动归零，不需要在 effect 里同步重置。
  const [typed, setTyped] = useState<{ sceneId: string; length: number }>({ sceneId: '', length: 0 })
  const typewriterTimerRef = useRef<number | null>(null)
  const narrative = currentScene?.narrative ?? ''
  const sceneId = currentScene?.id
  const typedLength = typed.sceneId === sceneId ? typed.length : 0

  useEffect(() => {
    if (!sceneId) return
    const text = narrative
    const startedAt = Date.now()
    typewriterTimerRef.current = window.setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000
      const nextLength = Math.min(text.length, Math.floor(elapsedSeconds * TYPEWRITER_CHARS_PER_SECOND))
      setTyped({ sceneId, length: nextLength })
      if (nextLength >= text.length && typewriterTimerRef.current !== null) {
        window.clearInterval(typewriterTimerRef.current)
        typewriterTimerRef.current = null
      }
    }, 40)
    return () => {
      if (typewriterTimerRef.current !== null) {
        window.clearInterval(typewriterTimerRef.current)
        typewriterTimerRef.current = null
      }
    }
  }, [sceneId, narrative])

  const skipTypewriter = () => {
    if (!currentScene || isReviewing) return
    if (typewriterTimerRef.current !== null) {
      window.clearInterval(typewriterTimerRef.current)
      typewriterTimerRef.current = null
    }
    setTyped({ sceneId: currentScene.id, length: currentScene.narrative.length })
  }

  const displayedNarrative = isReviewing
    ? scene?.narrative ?? ''
    : narrative.slice(0, typedLength)

  // 打字推进时跟随滚动，但用户手动上滚后不抢回滚动位置。
  const textPanelRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const panel = textPanelRef.current
    if (!panel) return
    const distanceToBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight
    if (distanceToBottom < FOLLOW_SCROLL_THRESHOLD) panel.scrollTop = panel.scrollHeight
  }, [displayedNarrative])

  const hasVideo = Boolean(scene?.videoStatus === 'ready' && scene.videoUrl)
  const videoUrl = hasVideo ? scene?.videoUrl : undefined
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 })

  // 优先带声音自动播放，被浏览器拦截时回退成静音播放，等用户主动打开声音。
  useEffect(() => {
    const video = videoRef.current
    if (!videoUrl || !video) return
    setProgress({ currentTime: 0, duration: 0 })
    video.muted = false
    setIsMuted(false)
    const played = video.play()
    if (!played) return
    played.catch(() => {
      video.muted = true
      setIsMuted(true)
      void video.play().catch(() => {})
    })
  }, [videoUrl])

  const togglePlayback = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  const toggleMuted = () => {
    const video = videoRef.current
    if (!video) return
    const nextMuted = !video.muted
    video.muted = nextMuted
    setIsMuted(nextMuted)
    if (!nextMuted && video.paused) void video.play().catch(() => {})
  }

  const seek = (nextTime: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = nextTime
    setProgress((current) => ({ ...current, currentTime: nextTime }))
  }

  const videoBadge = scene
    ? scene.videoStatus === 'generating' ? ['视频生成中…', 'generating'] as const
    : scene.videoStatus === 'ready' ? ['视频已就绪', 'ready'] as const
    : scene.videoStatus === 'failed' ? ['视频生成失败', 'failed'] as const
    : scene.videoStatus === 'skipped' ? ['视频生成已关闭', 'skipped'] as const
    : ['本幕未提交视频', 'none'] as const
    : null

  const canGenerateVideo = Boolean(onRetryVideo && scene?.videoRequest)

  return (
    <section className="game-stage-card">
      <div className="game-section-heading">
        <div>
          <div className="game-stage-title-row">
            <h2>{scene?.title ?? '故事开场'}</h2>
            {videoBadge && (
              <span className={`game-video-badge ${videoBadge[1]}`}>
                <span />{videoBadge[0]}
              </span>
            )}
            <button
              type="button"
              className={`game-video-toggle${videoGenerationEnabled ? ' on' : ''}`}
              aria-pressed={videoGenerationEnabled}
              title={videoGenerationEnabled ? '关闭后新的幕次不会提交 fal 生成视频' : '开启后新的幕次会自动提交 fal 生成视频'}
              onClick={() => onToggleVideoGeneration(!videoGenerationEnabled)}
            >
              {videoGenerationEnabled ? <Video size={12} /> : <VideoOff size={12} />}
              {videoGenerationEnabled ? '视频生成开' : '视频生成关'}
            </button>
          </div>
          <p>{scene ? `《后宫》· 第 ${scene.turn} 幕` : 'Pi 故事导演将主动决定第一幕'}</p>
        </div>
        <span className={`game-status ${statusClass}`}><span />{statusLabel}</span>
      </div>

      <article className={`game-stage-frame${hasVideo ? ' has-video' : ''}`}>
        <div className="game-stage-canvas">
          {videoUrl && (
            <video
              className="game-stage-video"
              key={videoUrl}
              ref={videoRef}
              src={videoUrl}
              loop
              playsInline
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onLoadedMetadata={(event) => setProgress({
                currentTime: event.currentTarget.currentTime,
                duration: event.currentTarget.duration,
              })}
              onTimeUpdate={(event) => setProgress({
                currentTime: event.currentTarget.currentTime,
                duration: event.currentTarget.duration,
              })}
            />
          )}

          {scene ? (
            <>
              {scene.videoStatus === 'generating' && (
                <div className="game-stage-notice">画面正在成形…</div>
              )}
              {scene.videoStatus === 'failed' && (
                <div className="game-stage-notice error">
                  <span>{scene.videoError ? `视频生成失败：${scene.videoError}` : '视频生成失败'}</span>
                  {canGenerateVideo && (
                    <button type="button" className="game-video-retry" onClick={() => onRetryVideo?.(scene.id)}>
                      重试
                    </button>
                  )}
                </div>
              )}
              {scene.videoStatus === 'skipped' && (
                <div className="game-stage-notice">
                  <span>本幕的视频生成已关闭</span>
                  {canGenerateVideo && (
                    <button type="button" className="game-video-retry neutral" onClick={() => onRetryVideo?.(scene.id)}>
                      生成本幕视频
                    </button>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="game-story-empty">
              <span className="game-player-icon"><Sparkles size={25} /></span>
              <strong>{session ? 'Pi 导演正在写下第一幕' : '宫门尚未开启'}</strong>
              <span>{hasApiKey ? '点击开始，让故事从一名秀女入宫的那一天展开' : '配置 DeepSeek Key 后开始故事'}</span>
            </div>
          )}

          {videoUrl && (
            <div className="game-stage-controls" onClick={(event) => event.stopPropagation()}>
              <button type="button" aria-label={isPlaying ? '暂停' : '播放'} onClick={togglePlayback}>
                {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </button>
              <span>{formatTime(progress.currentTime)}</span>
              <div className="game-stage-progress">
                <div
                  className="game-stage-progress-fill"
                  style={{ width: `${progress.duration ? Math.min(100, (progress.currentTime / progress.duration) * 100) : 0}%` }}
                />
                <input
                  type="range"
                  min="0"
                  max={progress.duration || 1}
                  step="0.05"
                  value={Math.min(progress.currentTime, progress.duration || 0)}
                  aria-label="调整视频播放进度"
                  onChange={(event) => seek(Number(event.target.value))}
                />
              </div>
              <span>{formatTime(progress.duration)}</span>
              <button type="button" aria-label={isMuted ? '打开声音' : '静音'} onClick={toggleMuted}>
                {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
              </button>
            </div>
          )}
        </div>

        {scene && (
          <aside
            className="game-stage-text"
            ref={textPanelRef}
            onClick={!isReviewing ? skipTypewriter : undefined}
          >
            <p>{displayedNarrative}</p>
          </aside>
        )}
      </article>

      {session && session.sceneHistory.length > 1 && (
        <nav className="game-scene-history" aria-label="已发布幕次">
          <div className="game-scene-history-heading">
            <span><History size={14} />幕次回看</span>
            <small>回看不会推进故事</small>
          </div>
          <div className="game-scene-history-track">
            {session.sceneHistory.map((historyScene, index) => {
              const isShown = historyScene.id === scene?.id
              const isCurrent = historyScene.id === currentScene?.id
              return (
                <button
                  className={isShown ? 'active' : ''}
                  type="button"
                  aria-pressed={isShown}
                  key={historyScene.id}
                  onClick={() => setReviewSceneId(isCurrent ? '' : historyScene.id)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div><strong>{historyScene.title}</strong><small>{isCurrent ? '当前幕' : '点击回看'}</small></div>
                </button>
              )
            })}
          </div>
        </nav>
      )}

      {!session && (
        <div className="game-start-actions">
          <div>
            <button className="button button-primary game-start-button" disabled={!hasApiKey} onClick={onStart}>
              <Play size={17} fill="currentColor" />请开始故事
            </button>
            <p className="game-cost-note">{hasApiKey ? '每一幕由 Pi Agent 续写，并自动提交 fal 生成场景视频。' : '请先在页面右上角配置 DeepSeek API Key。'}</p>
          </div>
        </div>
      )}
    </section>
  )
}
