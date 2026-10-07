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
  PenLine,
  Play,
  RotateCcw,
  Sparkles,
  UserRound,
  Volume2,
  VolumeX,
  Workflow,
} from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { MAX_REWRITE_REASON_LENGTH } from '../../hooks/useDirectorAgent'
import { isDirectorActive } from '../../services/directorStatus'
import { buildCharacterReferences } from '../../services/casting'
import { resolveReferenceDescriptors } from '../../services/sessionSegments'
import { buildClipGenerationInput } from '../../services/videoReferencePrompt'
import type { DirectorStatus } from '../../types/director'
import type { GameScene, GameSession, SceneVideoClip } from '../../types/game'
import type { Actor } from '../../types/actor'

type GameStageProps = {
  session: GameSession | null
  actors: Actor[]
  // 正在生成三视图的演员。
  generatingPortraitIds?: ReadonlySet<string>
  hasApiKey: boolean
  apiKeyLabel?: string
  directorStatus: DirectorStatus
  videoMode: NonNullable<GameScene['videoMode']>
  mediaRunning: boolean
  onStart: () => void
  onVideoModeChange: (next: NonNullable<GameScene['videoMode']>) => void
  // 「自动生成」开关（两种模式共用）：打开后分镜写好即自动逐段提交，关闭时整场生成只由玩家点击触发。
  autoGenerate: boolean
  onAutoGenerateChange: (next: boolean) => void
  onGenerateClip: (sceneId: string, sequence: number) => void
  onGenerateScene: (sceneId: string) => void
  onRewriteSegment: (sceneId: string, sequence: number, reason: string) => Promise<boolean>
  narrativeExpanded: boolean
  onNarrativeExpandedChange: (next: boolean) => void
}

const TYPEWRITER_CHARS_PER_SECOND = 40
const FOLLOW_SCROLL_THRESHOLD = 56

const getStatus = (session: GameSession | null, directorStatus: DirectorStatus, mediaRunning: boolean) => {
  if (!session) return ['等待开始', ''] as const
  if (session.status === 'awaiting_agent') {
    return isDirectorActive(directorStatus)
      ? ['导演写作中', 'busy'] as const
      : ['写作待恢复', 'error'] as const
  }
  if (session.status === 'awaiting_video') {
    if (isDirectorActive(directorStatus)) return ['导演重写中', 'busy'] as const
    return mediaRunning ? ['视频生成中', 'busy'] as const : ['等待视频', 'busy'] as const
  }
  return ['等待选择', ''] as const
}

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

const clipStatusLabel = (clip: SceneVideoClip) => {
  if (clip.status === 'waiting') return '等上一段'
  if (clip.status === 'pending') return '待生成'
  if (clip.status === 'generating') return '生成中'
  if (clip.status === 'ready') return '已完成'
  return '失败'
}

const clipSeconds = (clip: SceneVideoClip) => clip.endTime - clip.startTime

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

const PENDING_CLIP_STATUSES: SceneVideoClip['status'][] = ['waiting', 'pending', 'generating']

export function GameStage(props: GameStageProps) {
  const {
    session, actors, generatingPortraitIds, hasApiKey, apiKeyLabel = 'OpenRouter', directorStatus, videoMode, mediaRunning,
    onStart, onVideoModeChange, autoGenerate, onAutoGenerateChange, onGenerateClip, onGenerateScene, onRewriteSegment,
    narrativeExpanded, onNarrativeExpandedChange,
  } = props
  const [reviewSceneId, setReviewSceneId] = useState('')
  const currentScene = session?.currentScene
  const scene = session?.sceneHistory.find((item) => item.id === reviewSceneId) ?? currentScene
  const sceneIndex = session?.sceneHistory.findIndex((item) => item.id === scene?.id) ?? -1
  const isReviewing = Boolean(scene && currentScene && scene.id !== currentScene.id)
  const modeForHelp = isReviewing ? scene?.videoMode ?? videoMode : videoMode
  const [actionMessage, setActionMessage] = useState('')
  const [rewrite, setRewrite] = useState<{ sequence: number; reason: string } | null>(null)
  const [liveStatusLabel, liveStatusClass] = getStatus(session, directorStatus, mediaRunning)
  const statusLabel = isReviewing ? `回看第 ${sceneIndex + 1} 场次` : liveStatusLabel
  const statusClass = isReviewing ? 'reviewing' : liveStatusClass
  const isCurrent = Boolean(scene) && !isReviewing
  const directorBusy = isDirectorActive(directorStatus)
  // 与 switchVideoMode 的拦截条件一致：媒体或导演运行中、场次未开放选择时不能切换视频设置。
  const modeLocked = mediaRunning || directorBusy || (session ? session.status !== 'awaiting_action' : false)
  // 媒体操作只针对当前场次：等视频时逐段生成；已开放选择时仍可重做已完成的段。
  const canEditMedia = isCurrent && !mediaRunning && !directorBusy
    && (session?.status === 'awaiting_video' || session?.status === 'awaiting_action')
  const canRewrite = isCurrent && !mediaRunning && !directorBusy && session?.status === 'awaiting_video'

  // 打字进度带上场景 id，换场次时自动归零，不需要在 effect 里同步重置。
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
  const remainingClips = videoClips.filter((clip) => clip.status !== 'ready')
  const remainingSeconds = remainingClips.reduce((sum, clip) => sum + clipSeconds(clip), 0)
  const firstUnreadyClip = remainingClips[0]
  const videoBadge = scene
    ? failedClip ? ['有一段视频处理失败', 'failed'] as const
    : allClipsReady && !scene.videoSkippedReason ? ['视频已就绪', 'ready'] as const
    : scene.videoSkippedReason ? ['本场次未生成视频', 'skipped'] as const
    : videoClips.length ? [`视频处理中 ${readyClipCount}/${videoClips.length}`, 'generating'] as const
    : isCurrent && session?.status === 'awaiting_agent' ? ['导演正在编写分镜', 'generating'] as const
    : null
    : null
  const showSceneGenerate = isCurrent && session?.status === 'awaiting_video' && remainingClips.length > 0
  const canGenerateScene = canEditMedia && (firstUnreadyClip?.status === 'pending' || firstUnreadyClip?.status === 'failed')

  const waitingNotice = () => {
    if (!isCurrent) return '这一场次的视频没有完成。'
    if (!firstUnreadyClip) return ''
    if (firstUnreadyClip.status === 'generating') return `第 ${firstUnreadyClip.sequence} 段生成中…`
    if (session?.status !== 'awaiting_video') return ''
    if (!autoGenerate) return mediaRunning ? '正在处理视频…' : '整场分镜已写好，点时间轴上的「生成本场次视频」开始（按秒扣费）。'
    return `等待第 ${firstUnreadyClip.sequence} 段视频生成…`
  }

  const blockedClip = activeClip?.status === 'failed'
    ? activeClip
    : waitingForNext && nextClip?.status === 'failed' ? nextClip : undefined
  const isWaitingForClip = Boolean(activeClip && PENDING_CLIP_STATUSES.includes(activeClip.status))
    || Boolean(waitingForNext && nextClip && PENDING_CLIP_STATUSES.includes(nextClip.status))

  const timelineDuration = videoClips.reduce((sum, clip) => sum + (clip.actualDuration ?? clipSeconds(clip)), 0)
  const defaultSelectedIndex = isCurrent && firstUnreadyClip
    ? videoClips.indexOf(firstUnreadyClip)
    : videoClips.length - 1
  const timelineSelectedIndex = timelineSelection.sceneId === scene?.id
    ? Math.min(timelineSelection.index, Math.max(0, videoClips.length - 1))
    : Math.max(0, defaultSelectedIndex)
  const promptClip = videoClips[timelineSelectedIndex] ?? videoClips[0]

  const promptClipHasLater = Boolean(promptClip && videoClips.some((clip) => clip.sequence > promptClip.sequence))

  const openRewrite = (sequence: number) => {
    if (!canRewrite) return
    setRewrite({ sequence, reason: rewrite?.sequence === sequence ? rewrite.reason : '' })
  }

  const submitRewrite = (event: FormEvent) => {
    event.preventDefault()
    if (!scene || !rewrite || !canRewrite) return
    const reason = rewrite.reason.trim()
    if (!reason) return
    const { sequence } = rewrite
    setRewrite(null)
    setActionMessage(`已请导演重写第 ${sequence} 段。`)
    void onRewriteSegment(scene.id, sequence, reason).then((ok) => {
      setActionMessage(ok ? `导演已重写第 ${sequence} 段。` : `第 ${sequence} 段没有重写成功，详情见导演对话。`)
    })
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
  // 还没生成的段按当前演员库和已就绪的尾帧实时解析：这里展示的就是点生成时会提交的 prompt 和参考图。
  const promptReferences = !promptClip
    ? []
    : isCurrent && session && (promptClip.status === 'pending' || promptClip.status === 'waiting')
      ? resolveReferenceDescriptors(promptClip.referenceDescriptors ?? [], {
          characterReferences: buildCharacterReferences(session.characters, actors, session.castings),
          currentClips: videoClips,
          previousSceneTailFrameUrl: sceneIndex > 0 ? session.sceneHistory[sceneIndex - 1].tailFrameUrl : undefined,
        }).referenceImages
      : promptClip.referenceImages ?? []
  const promptInput = promptClip
    ? buildClipGenerationInput(promptClip.prompt, promptReferences, (actorId) => actorsById.get(actorId))
    : undefined
  const promptText = promptInput?.prompt ?? ''
  const charactersById = new Map((session?.characters ?? []).map((character) => [character.id, character]))
  const sceneCharacterIds = scene?.characterIds ?? [
    ...new Set(scene?.videoRequest?.videoPrompts.flatMap((segment) => segment.characterIds) ?? []),
  ]
  const castingsByCharacterId = new Map(
    (scene?.castings ?? []).map((casting) => [casting.characterId, casting.actorId]),
  )
  // 每段都用人物参考图；演员库里还没有参考图的演员按文字描述生成。
  const actorsMissingReference = isCurrent
    ? [...new Set(videoClips.filter((clip) => clip.status !== 'ready').flatMap((clip) =>
        (clip.referenceDescriptors ?? []).flatMap((descriptor) => {
          if (descriptor.type !== 'character') return []
          const actor = actorsById.get(descriptor.actorId)
          if (actor?.referenceImageUrl || generatingPortraitIds?.has(descriptor.actorId)) return []
          return [actor?.name ?? charactersById.get(descriptor.characterId)?.name ?? descriptor.characterId]
        })))]
    : []
  const actorsGeneratingPortrait = isCurrent
    ? [...new Set(videoClips.filter((clip) => clip.status !== 'ready').flatMap((clip) =>
        (clip.referenceDescriptors ?? []).flatMap((descriptor) => {
          if (descriptor.type !== 'character' || !generatingPortraitIds?.has(descriptor.actorId)) return []
          return [actorsById.get(descriptor.actorId)?.name ?? descriptor.actorId]
        })))]
    : []

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
          <p>{scene ? `《后宫》· 第 ${scene.turn} 场次` : '故事导演将主动决定第一场次'}</p>
        </div>
        <span className={`game-status ${statusClass}`}><span />{statusLabel}</span>
      </div>

      <section className="game-video-modes" aria-label="视频生成方式">
        <div className="game-video-mode-options">
          <button
            type="button"
            className={`game-video-mode${videoMode === 'auto' ? ' active' : ''}`}
            aria-pressed={videoMode === 'auto'}
            disabled={modeLocked}
            onClick={() => onVideoModeChange('auto')}
          >
            <strong><Sparkles size={15} />API 生成</strong>
            <span>通过 fal API 生成三视图和视频，整场分镜写好后逐段生成。</span>
          </button>
          <button
            type="button"
            className={`game-video-mode${videoMode === 'comfy' ? ' active' : ''}`}
            aria-pressed={videoMode === 'comfy'}
            disabled={modeLocked}
            onClick={() => onVideoModeChange('comfy')}
          >
            <strong><Workflow size={15} />ComfyUI 生成</strong>
            <span>用你的 Comfy Cloud 订阅跑 H3 官方工作流，整场分镜写好后逐段生成。</span>
          </button>
        </div>
        <div className="game-video-auto">
          <button
            type="button"
            className="agent-thinking-toggle"
            role="switch"
            aria-checked={autoGenerate}
            disabled={modeLocked}
            onClick={() => onAutoGenerateChange(!autoGenerate)}
          >
            <span className="agent-thinking-track" aria-hidden="true"><span /></span>
            自动生成
          </button>
          <small>分镜写好后自动逐段提交，按秒扣费</small>
        </div>
        <p className="game-video-mode-help">{autoGenerate
          ? `导演写好整场分镜后，页面调用 ${modeForHelp === 'auto' ? 'fal' : 'ComfyUI'} 自动逐段生成，按秒扣费，每段以上一段的尾帧开场。需要在设置里填写 ${modeForHelp === 'auto' ? 'fal' : 'Comfy'} API Key。`
          : `导演写好整场分镜后，由你点击生成，页面调用 ${modeForHelp === 'auto' ? 'fal' : 'ComfyUI'} 逐段生成，按秒扣费，每段以上一段的尾帧开场。需要在设置里填写 ${modeForHelp === 'auto' ? 'fal' : 'Comfy'} API Key。`}</p>
        <div className="game-video-mode-footer">
          <small>下一场次开始时，导演可以查看本场次最后一帧，决定接着拍还是换场景。</small>
        </div>
      </section>

      {scene && scene.castingStatus && (
        <section className="game-cast" aria-label="本场次演员">
          <div className="game-cast-heading">
            <span><UserRound size={13} />本场次演员</span>
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
              <p className="game-cast-error">{scene.castingError ?? '没有完成本场次选角。'}</p>
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
                  const portraitState = generatingPortraitIds?.has(actor.id)
                    ? '参考图生成中…'
                    : actor.portraitError ? '参考图生成失败，可到演员库重试' : '待生成参考图'
                  return (
                    <div className="game-cast-card pending" key={characterId} title={actor.portraitError}>
                      <span className="game-cast-placeholder"><UserRound size={16} /></span>
                      <div><strong>{actor.name}</strong><small>{portraitState}</small></div>
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
              {isWaitingForClip && !hasVideo && !blockedClip && !scene.videoSkippedReason && waitingNotice() && (
                <div className="game-stage-notice">{waitingNotice()}</div>
              )}
              {blockedClip && (
                <div className="game-stage-notice error">
                  <span>{`第 ${blockedClip.sequence} 段处理失败：${blockedClip.error ?? '未知错误'}`}</span>
                  {canEditMedia && (
                    <button type="button" className="game-video-retry" onClick={() => onGenerateClip(scene.id, blockedClip.sequence)}>
                      <RotateCcw size={12} />重试这一段
                    </button>
                  )}
                </div>
              )}
              {scene.videoSkippedReason && !hasVideo && (
                <div className="game-stage-notice">
                  <span>本场次未生成视频：{scene.videoSkippedReason}</span>
                </div>
              )}
            </>
          ) : (
            <div className="game-story-empty">
              <span className="game-player-icon"><Sparkles size={25} /></span>
              <strong>{session ? '导演正在写第一场次' : '宫门尚未开启'}</strong>
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
        <section className="game-video-timeline" aria-label="本场次视频时间轴">
          <div className="game-video-timeline-heading">
            <span><Clock3 size={14} />本场次视频</span>
            <small>{Number(timelineDuration.toFixed(1))} 秒 · {videoClips.length} 段</small>
          </div>
          {showSceneGenerate && (
            <div className="game-video-scene-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={!canGenerateScene}
                onClick={() => onGenerateScene(scene.id)}
              >
                {videoMode === 'comfy' ? <Workflow size={14} /> : <Sparkles size={14} />}
                {readyClipCount === 0
                  ? `生成本场次视频（共 ${remainingSeconds} 秒）`
                  : `继续生成剩余 ${remainingClips.length} 段（共 ${remainingSeconds} 秒）`}
              </button>
              <small>按秒扣费，逐段生成，每段以上一段的尾帧作为画面参考。</small>
            </div>
          )}
          {actorsGeneratingPortrait.length > 0 && (
            <p className="game-video-upload-help" role="status">
              正在生成参考图：{actorsGeneratingPortrait.join('、')}。生成视频时会先等参考图出来。
            </p>
          )}
          {actorsMissingReference.length > 0 && (
            <p className="game-video-reference-warning" role="status">
              本场次有演员还没有参考图：{actorsMissingReference.join('、')}。生成视频时会先自动补生成参考图（生成失败过的演员请到演员库重试），也可以直接按文字描述生成。
            </p>
          )}
          {mediaRunning && <p className="game-video-upload-help" role="status">正在处理视频…</p>}
          {actionMessage && <p className="game-video-upload-help" role="status">{actionMessage}</p>}
          <div className="game-video-timeline-track">
            {videoClips.map((clip, index) => {
              const duration = clip.actualDuration ?? clipSeconds(clip)
              const isSelected = index === timelineSelectedIndex
              const isOpen = clip.status === 'pending' || clip.status === 'failed'
              const hasLater = index < videoClips.length - 1
              const redoTitle = hasLater ? '之后的段会回到等待，需要重新生成' : undefined
              return (
                <div className="game-video-timeline-item-wrap" key={clip.sequence}>
                  {index > 0 && (
                    <span
                      className={`game-video-timeline-link${clip.startImageUrl ? ' linked' : ''}`}
                      title={clip.startImageUrl
                        ? '已使用上一段尾帧作为画面参考图'
                        : '等待上一段尾帧'}
                    >
                      <Link2 size={11} />
                    </span>
                  )}
                  <div className="game-video-timeline-clip">
                    <button
                      type="button"
                      className={`game-video-timeline-item ${clip.status}${isSelected ? ' selected' : ''}`}
                      style={{ width: `${Math.max(90, duration * 18)}px` }}
                      title={clip.prompt}
                      onClick={() => selectVideoClip(index)}
                    >
                      {clip.status === 'ready' && (clip.tailFrameUrl || clip.startImageUrl) ? (
                        <>
                          <img
                            src={clip.tailFrameUrl ?? clip.startImageUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                          <span className="game-video-timeline-tag">{clipStatusLabel(clip)}</span>
                        </>
                      ) : (
                        <span className="game-video-timeline-state">
                          {clip.status === 'generating' && <LoaderCircle className="spin" size={12} />}
                          {clip.status === 'failed' && <RotateCcw size={12} />}
                          {clipStatusLabel(clip)}
                        </span>
                      )}
                      <span className="game-video-timeline-meta">
                        <strong>第 {clip.sequence} 段</strong>
                        <small title={`计划 ${clipSeconds(clip)} 秒`}>{Number(duration.toFixed(1))} 秒</small>
                      </span>
                    </button>
                    {isCurrent && clip.status !== 'generating' && (
                      <div className="game-video-clip-actions">
                        {isOpen && (
                          <button
                            className="game-video-upload primary"
                            type="button"
                            disabled={!canEditMedia}
                            onClick={() => onGenerateClip(scene.id, clip.sequence)}
                          >
                            {videoMode === 'comfy' ? <Workflow size={12} /> : <Sparkles size={12} />}
                            {clip.status === 'failed' ? '重试这一段' : '生成这一段'}
                          </button>
                        )}
                        {clip.status === 'ready' && (
                          <button
                            className="game-video-upload"
                            type="button"
                            title={redoTitle}
                            disabled={!canEditMedia}
                            onClick={() => onGenerateClip(scene.id, clip.sequence)}
                          >
                            <RotateCcw size={12} />重新生成
                          </button>
                        )}
                        <button
                          className={`game-video-upload${rewrite?.sequence === clip.sequence ? ' active' : ''}`}
                          type="button"
                          disabled={!canRewrite}
                          onClick={() => openRewrite(clip.sequence)}
                        >
                          <PenLine size={12} />让导演重写
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {rewrite && isCurrent && (
            <form className="game-video-rewrite" onSubmit={submitRewrite}>
              <label htmlFor="game-video-rewrite-reason">让导演重写第 {rewrite.sequence} 段</label>
              <textarea
                id="game-video-rewrite-reason"
                value={rewrite.reason}
                maxLength={MAX_REWRITE_REASON_LENGTH}
                placeholder="写下要改的地方，例如：人物站位和上一段对不上，第二个镜头改成近景。"
                onChange={(event) => setRewrite({ sequence: rewrite.sequence, reason: event.target.value })}
              />
              <div className="game-video-rewrite-footer">
                <span>{rewrite.reason.length} / {MAX_REWRITE_REASON_LENGTH}</span>
                <button type="button" className="button button-secondary" onClick={() => setRewrite(null)}>取消</button>
                <button type="submit" className="button button-primary" disabled={!rewrite.reason.trim() || !canRewrite}>
                  <PenLine size={14} />提交重写
                </button>
              </div>
            </form>
          )}
          {isCurrent && canEditMedia && promptClip?.status === 'ready' && promptClipHasLater && (
            <p className="game-video-upload-help">重新生成第 {promptClip.sequence} 段后，之后的段会回到等待，需要重新生成。</p>
          )}
          {promptClip && (
            <div className="game-video-timeline-prompt">
              <div className="game-video-prompt-heading">
                <strong>第 {promptClip.sequence} 段 Prompt</strong>
                <button type="button" className="game-video-action" onClick={() => {
                  void navigator.clipboard.writeText(promptText).then(() => setActionMessage('Prompt 已复制。')).catch(() => setActionMessage('无法访问剪贴板，请选中 Prompt 手动复制。'))
                }}><Copy size={12} />复制 Prompt</button>
              </div>
              <div className="game-video-timeline-prompt-body">
                <p>{promptText}</p>
              </div>
              <div className="game-video-prompt-reference-section" aria-label="本段生成参考图">
                <strong className="game-video-prompt-reference-title">本段生成参考图</strong>
                {promptInput && (promptInput.images.length > 0 || promptInput.textOnlyCharacters.length > 0) && (
                  <div className="game-video-prompt-references">
                    {promptInput.images.map((image, index) => {
                      const label = `图${index + 1} · ${image.label}`
                      return (
                        <div className="game-video-reference" key={`${index}:${image.imageUrl}`}>
                          <a href={image.imageUrl} target="_blank" rel="noreferrer" title={`查看${label}`}>
                            <img src={image.imageUrl} alt={label} loading="lazy" decoding="async" />
                            <span>{label}</span>
                          </a>
                          <button type="button" className="game-video-action" onClick={() => { void downloadReference(image.imageUrl, image.label) }}><Download size={11} />下载参考图</button>
                        </div>
                      )
                    })}
                    {promptInput.textOnlyCharacters.map((character) => (
                      <div className="game-video-reference" key={`text:${character.name}`}>
                        <span className="game-video-prompt-reference-status">
                          {character.name} · {character.actorMissing ? '演员已删除' : '无参考图，按文字描述'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {promptClip.status === 'waiting' ? (
                  <p className="game-video-prompt-reference-status">上一段最后一帧：等上一段完成后作为画面参考图加入。</p>
                ) : promptInput && !promptInput.images.length && !promptInput.textOnlyCharacters.length && (
                  <p className="game-video-prompt-reference-status">本段没有参考图，将按纯文字 Prompt 生成。</p>
                )}
              </div>
            </div>
          )}
          {promptClip?.error && <p className="game-cast-error">{promptClip.error}</p>}
        </section>
      )}

      {session && session.sceneHistory.length > 1 && (
        <nav className="game-scene-history" aria-label="已发布场次">
          <div className="game-scene-history-heading">
            <span><History size={14} />场次回看</span>
            <small>回看不会推进故事</small>
          </div>
          <div className="game-scene-history-track">
            {session.sceneHistory.map((historyScene, index) => {
              const isShown = historyScene.id === scene?.id
              const isCurrentHistory = historyScene.id === currentScene?.id
              return (
                <button
                  className={isShown ? 'active' : ''}
                  type="button"
                  aria-pressed={isShown}
                  key={historyScene.id}
                  onClick={() => setReviewSceneId(isCurrentHistory ? '' : historyScene.id)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div><strong>{historyScene.title}</strong><small>{isCurrentHistory ? '当前场次' : '点击回看'}</small></div>
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
              : autoGenerate ? `开始后导演写好整场分镜，页面自动调用 ${videoMode === 'auto' ? 'fal' : 'ComfyUI'} 逐段生成视频，按秒扣费。`
                : `导演写好整场分镜后，由你点击生成，页面调用 ${videoMode === 'auto' ? 'fal' : 'ComfyUI'} 逐段生成，按秒扣费。`}</p>
          </div>
        </div>
      )}
    </section>
  )
}
