import {
  Clock3,
  History,
  Link2,
  LoaderCircle,
  Pause,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Sparkles,
  UserRound,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isDirectorActive } from '../../services/directorStatus'
import type { DirectorStatus } from '../../types/director'
import type { GameSession, SceneVideoClip } from '../../types/game'
import type { Actor } from '../../types/actor'

type GameStageProps = {
  session: GameSession | null
  actors: Actor[]
  hasApiKey: boolean
  apiKeyLabel?: string
  directorStatus: DirectorStatus
  videoGenerationEnabled: boolean
  onStart: () => void
  onToggleVideoGeneration: (next: boolean) => void
  onRetryVideo?: (sceneId: string) => void
  narrativeExpanded: boolean
  onNarrativeExpandedChange: (next: boolean) => void
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
  if (session.status === 'awaiting_media') return ['视频与尾帧处理中', 'busy'] as const
  return ['等待选择', ''] as const
}

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

const clipStatusLabel = (clip: SceneVideoClip) => {
  if (clip.status === 'waiting') return '等待前置片段尾帧'
  if (clip.status === 'generating') return '生成中'
  if (clip.status === 'extracting') return '提取尾帧'
  if (clip.status === 'analyzing') return 'DeepSeek 识别尾帧'
  if (clip.status === 'ready') return '已就绪'
  if (clip.status === 'failed') return '生成失败'
  return '已跳过'
}

const getClipVideoKey = (sceneId: string | undefined, clip: SceneVideoClip) => (
  `${sceneId ?? ''}:${clip.sequence}:${clip.videoUrl ?? ''}`
)

const MIN_SWITCH_BUFFER_SECONDS = 0.75

const hasSwitchBuffer = (video: HTMLVideoElement) => {
  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return true
  if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return false
  const remaining = Number.isFinite(video.duration)
    ? Math.max(0, video.duration - video.currentTime)
    : MIN_SWITCH_BUFFER_SECONDS
  const requiredBuffer = Math.min(MIN_SWITCH_BUFFER_SECONDS, remaining || MIN_SWITCH_BUFFER_SECONDS)
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (video.buffered.start(index) <= video.currentTime + 0.05
      && video.buffered.end(index) - video.currentTime >= requiredBuffer) return true
  }
  return false
}

const waitForSwitchBuffer = (video: HTMLVideoElement, onReady: () => void) => {
  let finished = false
  const events = ['canplay', 'canplaythrough', 'loadeddata', 'progress'] as const
  const cleanup = () => events.forEach((event) => video.removeEventListener(event, checkBuffer))
  const checkBuffer = () => {
    if (finished || !hasSwitchBuffer(video)) return
    finished = true
    cleanup()
    onReady()
  }
  events.forEach((event) => video.addEventListener(event, checkBuffer))
  checkBuffer()
  if (!finished) video.load()
  return cleanup
}

export function GameStage(props: GameStageProps) {
  const {
    session, actors, hasApiKey, apiKeyLabel = 'OpenRouter', directorStatus, videoGenerationEnabled,
    onStart, onToggleVideoGeneration, onRetryVideo,
    narrativeExpanded, onNarrativeExpandedChange,
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
  const textPanelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const panel = textPanelRef.current
    if (!panel) return
    const distanceToBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight
    if (distanceToBottom < FOLLOW_SCROLL_THRESHOLD) panel.scrollTop = panel.scrollHeight
  }, [displayedNarrative, narrativeExpanded])

  const videoClips = [...(scene?.videoClips ?? [])].sort((a, b) => a.sequence - b.sequence)
  const [playback, setPlayback] = useState({ sceneId: '', index: 0, waitingForNext: false })
  const [pendingPlayback, setPendingPlayback] = useState({ sceneId: '', index: -1 })
  const [timelineSelection, setTimelineSelection] = useState({ sceneId: '', index: 0 })
  const storedPlaybackIndex = playback.sceneId === scene?.id ? playback.index : 0
  const hasValidPlaybackIndex = storedPlaybackIndex === 0
    || videoClips[storedPlaybackIndex]?.status === 'ready'
  const playbackIndex = hasValidPlaybackIndex ? storedPlaybackIndex : 0
  const waitingForNext = hasValidPlaybackIndex
    && playback.sceneId === scene?.id
    && playback.waitingForNext
  const activeClip = videoClips[playbackIndex]
  const nextClip = videoClips[playbackIndex + 1]
  const pendingPlaybackIndex = pendingPlayback.sceneId === scene?.id ? pendingPlayback.index : -1
  const pendingClip = pendingPlaybackIndex >= 0 ? videoClips[pendingPlaybackIndex] : undefined
  const preloadIndex = pendingPlaybackIndex >= 0 ? pendingPlaybackIndex : playbackIndex + 1
  const videoUrl = activeClip?.status === 'ready' ? activeClip.videoUrl : undefined
  const hasVideo = Boolean(videoUrl)
  const videoRefs = useRef(new Map<string, HTMLVideoElement>())
  const isMutedRef = useRef(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [progress, setProgress] = useState({ currentTime: 0, duration: 0 })
  const lastProgressTimeRef = useRef(-1)

  useEffect(() => {
    if (!scene || !pendingClip?.videoUrl || pendingClip.status !== 'ready') return
    const pendingVideo = videoRefs.current.get(getClipVideoKey(scene.id, pendingClip))
    if (!pendingVideo) return
    pendingVideo.currentTime = 0
    return waitForSwitchBuffer(pendingVideo, () => {
      setPlayback({ sceneId: scene.id, index: pendingPlaybackIndex, waitingForNext: false })
      setPendingPlayback({ sceneId: '', index: -1 })
      setIsPlaying(false)
    })
  }, [pendingClip, pendingPlaybackIndex, scene])

  useEffect(() => {
    if (!scene || !waitingForNext || nextClip?.status !== 'ready' || !nextClip.videoUrl) return
    const nextVideo = videoRefs.current.get(getClipVideoKey(scene.id, nextClip))
    if (!nextVideo) return
    const showNextClip = () => {
      setPlayback({ sceneId: scene.id, index: playbackIndex + 1, waitingForNext: false })
    }
    return waitForSwitchBuffer(nextVideo, showNextClip)
  }, [nextClip, playbackIndex, scene, waitingForNext])

  // 优先带声音自动播放，被浏览器拦截时回退成静音播放，等用户主动打开声音。
  useEffect(() => {
    const video = activeClip ? videoRefs.current.get(getClipVideoKey(scene?.id, activeClip)) : undefined
    if (!videoUrl || !video) return
    lastProgressTimeRef.current = video.currentTime
    setProgress({ currentTime: video.currentTime, duration: video.duration || 0 })
    for (const item of videoRefs.current.values()) {
      if (item !== video) item.pause()
    }
    video.muted = isMutedRef.current
    const played = video.play()
    if (!played) return
    played.catch(() => {
      video.muted = true
      isMutedRef.current = true
      setIsMuted(true)
      void video.play().catch(() => {})
    })
  }, [activeClip, scene?.id, videoUrl])

  const togglePlayback = () => {
    const video = activeClip ? videoRefs.current.get(getClipVideoKey(scene?.id, activeClip)) : undefined
    if (!video) return
    if (video.ended && playbackIndex === videoClips.length - 1) {
      if (playbackIndex > 0 && videoClips[0]?.status === 'ready') {
        setPlayback({ sceneId: scene?.id ?? '', index: 0, waitingForNext: false })
        return
      }
      video.currentTime = 0
    }
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  const selectVideoClip = (index: number) => {
    if (!scene || !videoClips[index]) return
    setTimelineSelection({ sceneId: scene.id, index })
    if (videoClips[index].status !== 'ready') return
    if (index === playbackIndex) return
    const targetVideo = videoRefs.current.get(getClipVideoKey(scene.id, videoClips[index]))
    if (targetVideo) targetVideo.currentTime = 0
    if (targetVideo && hasSwitchBuffer(targetVideo)) {
      setPlayback({ sceneId: scene.id, index, waitingForNext: false })
      setPendingPlayback({ sceneId: '', index: -1 })
      setIsPlaying(false)
      return
    }
    setPendingPlayback({ sceneId: scene.id, index })
  }

  const handleVideoEnded = () => {
    setIsPlaying(false)
    if (pendingPlaybackIndex >= 0) return
    if (!scene || !nextClip) return
    if (nextClip.status === 'ready' && nextClip.videoUrl) {
      const nextVideo = videoRefs.current.get(getClipVideoKey(scene.id, nextClip))
      if (nextVideo && hasSwitchBuffer(nextVideo)) {
        setPlayback({ sceneId: scene.id, index: playbackIndex + 1, waitingForNext: false })
        return
      }
      setPlayback({ sceneId: scene.id, index: playbackIndex, waitingForNext: true })
      return
    }
    setPlayback({ sceneId: scene.id, index: playbackIndex, waitingForNext: true })
  }

  const toggleMuted = () => {
    const video = activeClip ? videoRefs.current.get(getClipVideoKey(scene?.id, activeClip)) : undefined
    if (!video) return
    const nextMuted = !video.muted
    video.muted = nextMuted
    isMutedRef.current = nextMuted
    setIsMuted(nextMuted)
    if (!nextMuted && video.paused) void video.play().catch(() => {})
  }

  const seek = (nextTime: number) => {
    const video = activeClip ? videoRefs.current.get(getClipVideoKey(scene?.id, activeClip)) : undefined
    if (!video) return
    video.currentTime = nextTime
    setProgress((current) => ({ ...current, currentTime: nextTime }))
  }

  const updateProgress = (video: HTMLVideoElement, force = false) => {
    if (!force && Math.abs(video.currentTime - lastProgressTimeRef.current) < 0.2) return
    lastProgressTimeRef.current = video.currentTime
    setProgress({ currentTime: video.currentTime, duration: video.duration || 0 })
  }

  const readyClipCount = videoClips.filter((clip) => clip.status === 'ready').length
  const failedClip = videoClips.find((clip) => clip.status === 'failed')
  const allClipsReady = videoClips.length > 0 && readyClipCount === videoClips.length
  const allClipsSkipped = videoClips.length > 0 && videoClips.every((clip) => clip.status === 'skipped')
  const videoBadge = scene
    ? failedClip ? ['部分片段生成失败', 'failed'] as const
    : allClipsReady ? ['视频已就绪', 'ready'] as const
    : allClipsSkipped ? ['视频生成已关闭', 'skipped'] as const
    : videoClips.length ? [`视频生成中 ${readyClipCount}/${videoClips.length}`, 'generating'] as const
    : videoGenerationEnabled ? ['视频计划生成中', 'generating'] as const
    : ['本幕未提交视频', 'none'] as const
    : null

  const blockedClip = activeClip?.status === 'failed'
    ? activeClip
    : waitingForNext && nextClip?.status === 'failed' ? nextClip : undefined
  const pendingStatuses: SceneVideoClip['status'][] = ['waiting', 'generating', 'extracting', 'analyzing']
  const isWaitingForClip = Boolean(activeClip && pendingStatuses.includes(activeClip.status))
    || Boolean(waitingForNext && nextClip && pendingStatuses.includes(nextClip.status))

  const canGenerateVideo = Boolean(onRetryVideo && scene?.videoRequest)
  const timelineDuration = scene?.videoRequest?.totalDuration
    ?? videoClips.at(-1)?.endTime
    ?? 0
  const timelineSelectedIndex = timelineSelection.sceneId === scene?.id
    ? Math.min(timelineSelection.index, Math.max(0, videoClips.length - 1))
    : playbackIndex
  const promptClip = videoClips[timelineSelectedIndex] ?? videoClips[0]
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]))
  const charactersById = new Map((session?.characters ?? []).map((character) => [character.id, character]))
  const sceneCharacterIds = scene?.characterIds ?? [
    ...new Set(scene?.videoRequest?.videoPrompts.flatMap((segment) => segment.characterIds) ?? []),
  ]
  const castingsByCharacterId = new Map(
    (scene?.castings ?? []).map((casting) => [casting.characterId, casting.actorId]),
  )

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

      {scene && scene.castingStatus && (
        <section className="game-cast" aria-label="本幕演员">
          <div className="game-cast-heading">
            <span><UserRound size={13} />本幕演员</span>
            <small>
              {scene.castingStatus === 'selecting'
                ? '正在选角'
                : scene.castingStatus === 'failed'
                  ? '选角失败'
                  : `${scene.castings?.length ?? 0}/${sceneCharacterIds.length} 已匹配`}
            </small>
          </div>
          <div className="game-cast-track">
            {scene.castingStatus === 'selecting' ? (
              Array.from({ length: Math.max(1, sceneCharacterIds.length) }, (_, index) => (
                <div className="game-cast-card loading" key={sceneCharacterIds[index] ?? index}>
                  <span className="game-cast-skeleton" />
                  <div><strong>正在选角</strong><small>查询演员库…</small></div>
                </div>
              ))
            ) : scene.castingStatus === 'failed' ? (
              <p className="game-cast-error">{scene.castingError ?? '没有完成本幕选角。'}</p>
            ) : (
              sceneCharacterIds.map((characterId) => {
                const character = charactersById.get(characterId)
                const actorId = castingsByCharacterId.get(characterId)
                const actor = actorId ? actorsById.get(actorId) : undefined
                if (!actor) {
                  return (
                    <div className="game-cast-card unmatched" key={characterId}>
                      <span className="game-cast-placeholder"><UserRound size={16} /></span>
                      <div><strong>{character?.name ?? characterId}</strong><small>未匹配演员</small></div>
                    </div>
                  )
                }
                return (
                  <a
                    className="game-cast-card"
                    href={actor.referenceImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`查看${actor.name}的演员参考图`}
                    key={characterId}
                  >
                    <img src={actor.referenceImageUrl} alt={`${actor.name}参考图`} loading="lazy" decoding="async" />
                    <div><strong>{actor.name}</strong><small>饰 {character?.name ?? characterId}</small></div>
                  </a>
                )
              })
            )}
          </div>
        </section>
      )}

      <article className={`game-stage-frame${hasVideo ? ' has-video' : ''}${narrativeExpanded ? '' : ' narrative-collapsed'}`}>
        <div className="game-stage-canvas">
          {videoClips.map((clip, index) => {
            if ((index !== playbackIndex && index !== preloadIndex)
              || clip.status !== 'ready' || !clip.videoUrl) return null
            const isActive = index === playbackIndex
            const videoKey = getClipVideoKey(scene?.id, clip)
            return (
              <video
                className={`game-stage-video${isActive ? ' active' : ''}`}
                key={videoKey}
                ref={(element) => {
                  if (element) videoRefs.current.set(videoKey, element)
                  else videoRefs.current.delete(videoKey)
                }}
                src={clip.videoUrl}
                poster={clip.startImageUrl}
                preload="auto"
                playsInline
                onPlay={() => {
                  if (isActive) setIsPlaying(true)
                }}
                onPause={() => {
                  if (isActive) setIsPlaying(false)
                }}
                onEnded={() => {
                  if (isActive) handleVideoEnded()
                }}
                onLoadedMetadata={(event) => {
                  if (isActive) updateProgress(event.currentTarget, true)
                }}
                onTimeUpdate={(event) => {
                  if (isActive) updateProgress(event.currentTarget)
                }}
              />
            )
          })}

          {scene ? (
            <>
              {isWaitingForClip && (
                <div className="game-stage-notice">
                  {waitingForNext ? `等待第 ${nextClip?.sequence} 段生成完成…` : '首段画面正在成形…'}
                </div>
              )}
              {blockedClip && (
                <div className="game-stage-notice error">
                  <span>{`第 ${blockedClip.sequence} 段生成失败：${blockedClip.error ?? '未知错误'}`}</span>
                  {canGenerateVideo && (
                    <button type="button" className="game-video-retry" onClick={() => onRetryVideo?.(scene.id)}>
                      重新生成本幕
                    </button>
                  )}
                </div>
              )}
              {allClipsSkipped && (
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
              <span>{hasApiKey ? '点击开始，让故事从一名秀女入宫的那一天展开' : `配置 ${apiKeyLabel} Key 后开始故事`}</span>
            </div>
          )}

          {videoUrl && (
            <div className="game-stage-controls" onClick={(event) => event.stopPropagation()}>
              <button type="button" aria-label={isPlaying ? '暂停' : '播放'} onClick={togglePlayback}>
                {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              </button>
              <span>{playbackIndex + 1}/{videoClips.length}</span>
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

          {scene && !narrativeExpanded && (
            <button
              type="button"
              className="game-stage-text-restore"
              aria-label="展开剧情文字"
              aria-expanded={false}
              aria-controls="game-stage-narrative"
              title="展开剧情文字"
              onClick={() => onNarrativeExpandedChange(true)}
            >
              <PanelRightOpen size={15} />
            </button>
          )}
        </div>

        {scene && narrativeExpanded && (
          <aside
            id="game-stage-narrative"
            className="game-stage-text"
          >
            <div className="game-stage-text-toolbar">
              <button
                type="button"
                aria-label="收起剧情文字"
                aria-expanded={true}
                aria-controls="game-stage-narrative"
                title="收起剧情文字"
                onClick={() => onNarrativeExpandedChange(false)}
              >
                <PanelRightClose size={15} />
              </button>
            </div>
            <div
              className="game-stage-text-scroll"
              ref={textPanelRef}
              onClick={!isReviewing ? skipTypewriter : undefined}
            >
              <p>{displayedNarrative}</p>
            </div>
          </aside>
        )}
      </article>

      {scene && videoClips.length > 0 && (
        <section className="game-video-timeline" aria-label="本幕视频时间轴">
          <div className="game-video-timeline-heading">
            <span><Clock3 size={14} />本幕视频</span>
            <small>{timelineDuration} 秒 · {videoClips.length} 个片段</small>
          </div>
          <div className="game-video-timeline-track">
            {videoClips.map((clip, index) => {
              const duration = clip.endTime - clip.startTime
              const isSelected = index === timelineSelectedIndex
              const isPending = pendingStatuses.includes(clip.status)
              return (
                <div className="game-video-timeline-item-wrap" key={clip.sequence}>
                  {index > 0 && (
                    <span
                      className={`game-video-timeline-link${clip.startImageUrl ? ' linked' : ''}`}
                      title={clip.startImageUrl
                        ? '已使用上一片段尾帧作为起始参考'
                        : '等待上一片段尾帧'}
                    >
                      <Link2 size={11} />
                    </span>
                  )}
                  <button
                    type="button"
                    className={`game-video-timeline-item ${clip.status}${isSelected ? ' selected' : ''}`}
                    style={{ width: `${Math.max(90, duration * 18)}px` }}
                    title={clip.prompt}
                    onClick={() => selectVideoClip(index)}
                  >
                    {clip.status === 'ready' && (clip.tailFrameUrl || clip.startImageUrl) ? (
                      <img
                        src={clip.tailFrameUrl ?? clip.startImageUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      <span className="game-video-timeline-state">
                        {isPending && <LoaderCircle className="spin" size={12} />}
                        {clip.status === 'failed' && <RotateCcw size={12} />}
                        {clipStatusLabel(clip)}
                      </span>
                    )}
                    <span className="game-video-timeline-meta">
                      <strong>片段 {clip.sequence}</strong>
                      <small>{duration} 秒</small>
                    </span>
                  </button>
                  {clip.status === 'failed' && canGenerateVideo && (
                    <button
                      type="button"
                      className="game-video-timeline-retry"
                      title="从此片段继续生成，后续依赖片段将重新生成"
                      aria-label={`重试片段 ${clip.sequence}`}
                      onClick={() => onRetryVideo?.(scene.id)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          {promptClip && (
            <div className="game-video-timeline-prompt">
              <strong>片段 {promptClip.sequence} Prompt</strong>
              <div className="game-video-timeline-prompt-body">
                <p>{promptClip.prompt}</p>
              </div>
              <div className="game-video-prompt-reference-section" aria-label="发给 fal 的参考图">
                <strong className="game-video-prompt-reference-title">发给 fal 的参考图</strong>
                {promptClip.referenceImages === undefined ? (
                  <p className="game-video-prompt-reference-status">
                    {promptClip.status === 'waiting'
                      ? '等待上一片段尾帧；生成开始后将在这里显示实际发送的图片。'
                      : promptClip.status === 'skipped'
                        ? '视频生成已关闭，未向 fal 发送请求。'
                        : ['generating', 'extracting', 'analyzing'].includes(promptClip.status)
                          ? '正在确认发送给 fal 的参考图…'
                          : '本片段没有已记录的 fal 参考图。'}
                  </p>
                ) : promptClip.referenceImages.length > 0 ? (
                  <div className="game-video-prompt-references">
                    {promptClip.referenceImages.map((reference) => (
                      <a
                        href={reference.imageUrl}
                        key={`${reference.type}:${reference.imageUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        title={`查看${reference.label}`}
                      >
                        <img src={reference.imageUrl} alt={reference.label} loading="lazy" decoding="async" />
                        <span>{reference.label}</span>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="game-video-prompt-reference-status">本次请求没有向 fal 发送参考图。</p>
                )}
              </div>
            </div>
          )}
        </section>
      )}

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
            <p className="game-cost-note">{hasApiKey ? '每一幕由 Pi Agent 续写，并自动提交 fal 生成场景视频。' : `请先在页面右上角配置 ${apiKeyLabel} API Key。`}</p>
          </div>
        </div>
      )}
    </section>
  )
}
