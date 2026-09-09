import {
  Clock3,
  Copy,
  Download,
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
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isDirectorActive } from '../../services/directorStatus'
import { buildClipPrompt } from '../../services/videoReferencePrompt'
import type { DirectorStatus } from '../../types/director'
import type { GameScene, GameSession, SceneVideoClip } from '../../types/game'
import type { Actor } from '../../types/actor'
import type { VideoInputReferenceImage } from '../../types/video'

type GameStageProps = {
  session: GameSession | null
  actors: Actor[]
  hasApiKey: boolean
  apiKeyLabel?: string
  directorStatus: DirectorStatus
  videoMode: NonNullable<GameScene['videoMode']>
  mediaRunning: boolean
  onStart: () => void
  onVideoModeChange: (next: NonNullable<GameScene['videoMode']>) => void
  onUploadVideo: (sceneId: string, sequence: number, file: File) => Promise<void>
  onRetrySegment: (sceneId: string) => void
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
  if (session.status === 'awaiting_upload') return ['等待视频', 'busy'] as const
  return ['等待选择', ''] as const
}

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

const clipStatusLabel = (clip: SceneVideoClip, videoMode: NonNullable<GameScene['videoMode']>) => {
  if (clip.status === 'written') return '已写好'
  if (clip.status === 'awaiting_upload') return videoMode === 'auto' ? '等待生成' : '等待上传'
  if (clip.status === 'generating') return '生成中'
  if (clip.status === 'analyzing') return '识别尾帧中'
  if (clip.status === 'ready') return '已完成'
  return '失败'
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

const PENDING_CLIP_STATUSES: SceneVideoClip['status'][] = ['written', 'awaiting_upload', 'generating', 'analyzing']

export function GameStage(props: GameStageProps) {
  const {
    session, actors, hasApiKey, apiKeyLabel = 'OpenRouter', directorStatus, videoMode, mediaRunning,
    onStart, onVideoModeChange, onUploadVideo, onRetrySegment,
    narrativeExpanded, onNarrativeExpandedChange,
  } = props
  const [reviewSceneId, setReviewSceneId] = useState('')
  const currentScene = session?.currentScene
  const scene = session?.sceneHistory.find((item) => item.id === reviewSceneId) ?? currentScene
  const sceneIndex = session?.sceneHistory.findIndex((item) => item.id === scene?.id) ?? -1
  const isReviewing = Boolean(scene && currentScene && scene.id !== currentScene.id)
  const modeForHelp = isReviewing ? scene?.videoMode ?? videoMode : videoMode
  const [actionMessage, setActionMessage] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const [liveStatusLabel, liveStatusClass] = getStatus(session, directorStatus)
  const pendingUpload = !isReviewing && session && session.pendingUpload?.sceneId === scene?.id ? session.pendingUpload : undefined
  const statusLabel = isReviewing ? `回看第 ${sceneIndex + 1} 幕`
    : pendingUpload && !mediaRunning ? (videoMode === 'auto' ? '等待生成' : '等待上传')
    : liveStatusLabel
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
  const videoBadge = scene
    ? failedClip ? ['这一段视频处理失败', 'failed'] as const
    : allClipsReady && !scene.videoSkippedReason ? ['视频已就绪', 'ready'] as const
    : scene.videoSkippedReason ? ['本幕未生成视频', 'skipped'] as const
    : videoClips.length ? [`视频处理中 ${readyClipCount}/${videoClips.length}`, 'generating'] as const
    : ['导演正在编写视频 Prompt', 'generating'] as const
    : null

  const blockedClip = activeClip?.status === 'failed'
    ? activeClip
    : waitingForNext && nextClip?.status === 'failed' ? nextClip : undefined
  const isWaitingForClip = Boolean(activeClip && PENDING_CLIP_STATUSES.includes(activeClip.status))
    || Boolean(waitingForNext && nextClip && PENDING_CLIP_STATUSES.includes(nextClip.status))

  const timelineDuration = videoClips.reduce((sum, clip) => sum + (clip.actualDuration ?? clip.endTime - clip.startTime), 0)
  const defaultSelectedIndex = pendingUpload
    ? videoClips.findIndex((clip) => clip.sequence === pendingUpload.sequence)
    : videoClips.length - 1
  const timelineSelectedIndex = timelineSelection.sceneId === scene?.id
    ? Math.min(timelineSelection.index, Math.max(0, videoClips.length - 1))
    : Math.max(0, defaultSelectedIndex)
  const promptClip = videoClips[timelineSelectedIndex] ?? videoClips[0]
  const promptText = promptClip ? buildClipPrompt(promptClip) : ''

  const canUpload = !isReviewing && Boolean(pendingUpload) && !mediaRunning && !isDirectorActive(directorStatus)
  const chooseUpload = () => {
    if (!canUpload || !scene) return
    setActionMessage('')
    uploadInput.current?.click()
  }
  const downloadReference = async (imageUrl: string, label: string) => {
    try {
      const response = await fetch(imageUrl)
      if (!response.ok) throw new Error('下载失败，可点击图片打开后保存。')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${label}.${blob.type === 'image/png' ? 'png' : 'jpg'}`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) { setActionMessage(error instanceof Error ? error.message : '参考图下载失败') }
  }
  const actorsById = new Map(actors.map((actor) => [actor.id, actor]))
  // 演员参考图只按 actorId 存档，展示时用当前演员库解析。
  const resolveReferenceImage = (reference: VideoInputReferenceImage) => reference.imageUrl
    ?? (reference.actorId ? actorsById.get(reference.actorId)?.referenceImageUrl : undefined)
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
          </div>
          <p>{scene ? `《后宫》· 第 ${scene.turn} 幕` : 'Pi 故事导演将主动决定第一幕'}</p>
        </div>
        <span className={`game-status ${statusClass}`}><span />{statusLabel}</span>
      </div>

      <section className="game-video-modes" aria-label="视频生成方式">
        <div className="game-video-mode-options">
          <button
            type="button"
            className={`game-video-mode${videoMode === 'manual' ? ' active' : ''}`}
            aria-pressed={videoMode === 'manual'}
            disabled={mediaRunning || isDirectorActive(directorStatus) || (session ? session.status !== 'awaiting_action' : false)}
            onClick={() => onVideoModeChange('manual')}
          >
            <strong><Upload size={15} />上传视频</strong>
            <span>使用你在其他平台的额度生成，再上传到这里。</span>
          </button>
          <button
            type="button"
            className={`game-video-mode${videoMode === 'auto' ? ' active' : ''}`}
            aria-pressed={videoMode === 'auto'}
            disabled={mediaRunning || isDirectorActive(directorStatus) || (session ? session.status !== 'awaiting_action' : false)}
            onClick={() => onVideoModeChange('auto')}
          >
            <strong><Sparkles size={15} />API 生成</strong>
            <span>通过已接入的 fal API 自动生成并衔接视频。</span>
          </button>
        </div>
        <p className="game-video-mode-help">{modeForHelp === 'manual'
          ? '导演每写好一段就在这里等你上传；上传后导演按实测尾帧写下一段。'
          : modeForHelp === 'auto'
            ? '导演每写好一段自动调用 fal 生成，按实测尾帧写下一段。需要 FAL_KEY。'
            : '仅续写故事与编写 Prompt，暂不生成或上传视频。'}</p>
        <div className="game-video-mode-footer">
          <small>视觉反馈当前分析最终尾帧，不包含整段视频的动作与音频。</small>
          <button
            type="button"
            className="game-video-action"
            aria-pressed={videoMode === 'off'}
            disabled={mediaRunning || isDirectorActive(directorStatus) || (session ? session.status !== 'awaiting_action' : false)}
            onClick={() => onVideoModeChange('off')}
          >仅文字</button>
        </div>
      </section>

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
                if (!actor.referenceImageUrl) {
                  return (
                    <div className="game-cast-card pending" key={characterId}>
                      <span className="game-cast-placeholder"><UserRound size={16} /></span>
                      <div><strong>{actor.name}</strong><small>待生成参考图</small></div>
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
              {isWaitingForClip && !hasVideo && (
                <div className="game-stage-notice">
                  {pendingUpload ? `等待第 ${pendingUpload.sequence} 段视频${videoMode === 'auto' ? '生成' : '上传'}…` : '导演正在编写这一段…'}
                </div>
              )}
              {blockedClip && (
                <div className="game-stage-notice error">
                  <span>{`第 ${blockedClip.sequence} 段处理失败：${blockedClip.error ?? '未知错误'}`}</span>
                  {!isReviewing && session?.status === 'awaiting_upload' && (
                    <button type="button" className="game-video-retry" onClick={() => onRetrySegment(scene.id)}>
                      <RotateCcw size={12} />重试
                    </button>
                  )}
                </div>
              )}
              {scene.videoSkippedReason && (
                <div className="game-stage-notice">
                  <span>本幕未生成视频：{scene.videoSkippedReason}</span>
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
            <small>{Number(timelineDuration.toFixed(1))} 秒 · {videoClips.length} 个片段</small>
          </div>
          {mediaRunning && <p className="game-video-upload-help" role="status">正在处理视频…</p>}
          {actionMessage && <p className="game-video-upload-help" role="status">{actionMessage}</p>}
          <input
            ref={uploadInput}
            type="file"
            accept="video/*,.mp4,.mov,.webm"
            hidden
            aria-label="选择片段视频"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file || !scene || !pendingUpload) return
              void onUploadVideo(scene.id, pendingUpload.sequence, file).then(() => {
                setActionMessage(`片段 ${pendingUpload.sequence} 已上传。`)
              }).catch((error: unknown) => setActionMessage(error instanceof Error ? error.message : '上传失败'))
            }}
          />
          <div className="game-video-timeline-track">
            {videoClips.map((clip, index) => {
              const duration = clip.actualDuration ?? clip.endTime - clip.startTime
              const isSelected = index === timelineSelectedIndex
              const isPending = PENDING_CLIP_STATUSES.includes(clip.status)
              const isUploadTarget = !isReviewing && pendingUpload?.sequence === clip.sequence
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
                        {clipStatusLabel(clip, videoMode)}
                      </span>
                    )}
                    <span className="game-video-timeline-meta">
                      <strong>片段 {clip.sequence}</strong>
                      <small title={`计划 ${clip.endTime - clip.startTime} 秒`}>{Number(duration.toFixed(1))} 秒</small>
                    </span>
                    {clip.status === 'ready' && clip.visualState && (
                      <small className="game-video-timeline-visual">
                        {clip.visualState.shot_size} · {clip.visualState.shot_content.scene.location}
                      </small>
                    )}
                  </button>
                  {isUploadTarget && (
                    <button
                      className="game-video-upload"
                      type="button"
                      aria-label="上传片段视频"
                      disabled={!canUpload}
                      onClick={chooseUpload}
                    >
                      <Upload size={12} />上传视频
                    </button>
                  )}
                  {clip.status === 'failed' && !isReviewing && session?.status === 'awaiting_upload' && (
                    <button
                      type="button"
                      className="game-video-timeline-retry"
                      title="重试这一片段"
                      aria-label={`重试片段 ${clip.sequence}`}
                      onClick={() => onRetrySegment(scene.id)}
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
              <div className="game-video-prompt-heading">
                <strong>片段 {promptClip.sequence} Prompt</strong>
                <button type="button" className="game-video-action" onClick={() => {
                  void navigator.clipboard.writeText(promptText).then(() => setActionMessage('Prompt 已复制。')).catch(() => setActionMessage('无法访问剪贴板，请选中 Prompt 手动复制。'))
                }}><Copy size={12} />复制 Prompt</button>
              </div>
              <div className="game-video-timeline-prompt-body">
                <p>{promptText}</p>
              </div>
              <div className="game-video-prompt-reference-section" aria-label="本片段生成参考图">
                <strong className="game-video-prompt-reference-title">本片段生成参考图</strong>
                {promptClip.referenceImages && promptClip.referenceImages.length > 0 ? (
                  <div className="game-video-prompt-references">
                    {promptClip.referenceImages.map((reference, index) => {
                      const imageUrl = resolveReferenceImage(reference)
                      if (!imageUrl) {
                        return (
                          <div className="game-video-reference" key={`${reference.type}:${reference.actorId ?? index}`}>
                            <span className="game-video-prompt-reference-status">{reference.label} · 演员已删除</span>
                          </div>
                        )
                      }
                      return (
                        <div className="game-video-reference" key={`${reference.type}:${reference.actorId ?? imageUrl}`}>
                          <a
                            href={imageUrl}
                            target="_blank"
                            rel="noreferrer"
                            title={`查看${reference.label}`}
                          >
                            <img src={imageUrl} alt={reference.label} loading="lazy" decoding="async" />
                            <span>{reference.label}</span>
                          </a>
                          <button type="button" className="game-video-action" onClick={() => { void downloadReference(imageUrl, reference.label) }}><Download size={11} />下载参考图</button>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="game-video-prompt-reference-status">本片段没有可用的参考图，将按纯文字 Prompt 生成。</p>
                )}
              </div>
            </div>
          )}
          {promptClip?.error && <p className="game-cast-error">{promptClip.error}</p>}
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
            <p className="game-cost-note">{!hasApiKey ? `请先在页面右上角配置 ${apiKeyLabel} API Key。`
              : videoMode === 'manual' ? '开始后导演会逐段编写 Prompt，等待你在外部生成并上传视频。'
                : videoMode === 'auto' ? '开始后导演会逐段自动调用 fal 生成视频，消耗对应 API 额度。'
                  : '开始后续写故事与编写 Prompt。'}</p>
          </div>
        </div>
      )}
    </section>
  )
}
