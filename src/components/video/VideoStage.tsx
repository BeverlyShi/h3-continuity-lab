import {
  ChevronRight,
  Clock3,
  Download,
  FolderPlus,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import type { RefObject } from 'react'
import type { VideoClip } from '../../types/video'

type PlaybackProgress = { clipId: string; currentTime: number; duration: number }

type VideoStageProps = {
  clips: VideoClip[]
  activeClip?: VideoClip
  activeIndex: number
  hasActiveProject: boolean
  isUserPaused: boolean
  isWaitingForNext: boolean
  queueStatus: string
  playbackProgress: PlaybackProgress
  videoRef: RefObject<HTMLVideoElement | null>
  onPlaybackProgressChange: (progress: PlaybackProgress) => void
  onEnded: () => void
  onPlay: () => void
  onPause: () => void
  onTogglePlayback: () => void
  onSelectClip: (index: number) => void
  onRetryClip: (clipId: string) => void
  onDownloadClip: (index: number) => void
}

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

export function VideoStage(props: VideoStageProps) {
  const {
    clips, activeClip, activeIndex, hasActiveProject, isUserPaused,
    isWaitingForNext, queueStatus, playbackProgress, videoRef,
    onPlaybackProgressChange, onEnded, onPlay, onPause, onTogglePlayback,
    onSelectClip, onRetryClip, onDownloadClip,
  } = props
  const hasPlayableActiveClip = Boolean(activeClip && ['ready', 'playing', 'completed'].includes(activeClip.status))
  const activeFailure = activeClip?.status === 'failed' ? activeClip : undefined
  const nextPlayableClip = clips[activeIndex + 1]
  const waitingFailure = isWaitingForNext && nextPlayableClip?.status === 'failed'
  const shouldPreloadNext = Boolean(nextPlayableClip && ['ready', 'playing', 'completed'].includes(nextPlayableClip.status))
  const activeProgress = playbackProgress.clipId === activeClip?.id
    ? playbackProgress
    : { clipId: activeClip?.id ?? '', currentTime: 0, duration: 0 }
  const progressPercent = activeProgress.duration
    ? Math.min(100, (activeProgress.currentTime / activeProgress.duration) * 100)
    : 0

  return (
    <section className="stage-column">
      <div className="section-heading">
        <div><h1>连续视频预览</h1><p>片段生成后会自动加入播放队列</p></div>
        <div className="status-line">
          <span className={queueStatus ? 'status-dot status-dot-busy' : 'status-dot'} />
          {queueStatus || (clips.length ? '队列已同步' : '等待首个 Prompt')}
        </div>
      </div>

      <div className="player-frame">
        {hasPlayableActiveClip && activeClip ? (
          <>
            {shouldPreloadNext && nextPlayableClip?.videoUrl && (
              <video className="video-preload" src={nextPlayableClip.videoUrl} preload="auto" muted playsInline aria-hidden="true" />
            )}
            <video
              ref={videoRef}
              key={activeClip.id}
              src={activeClip.videoUrl}
              poster={activeClip.thumbnailUrl}
              playsInline
              onEnded={onEnded}
              onPlay={onPlay}
              onPause={onPause}
              onLoadedMetadata={(event) => onPlaybackProgressChange({
                clipId: activeClip.id,
                currentTime: event.currentTarget.currentTime,
                duration: event.currentTarget.duration,
              })}
              onTimeUpdate={(event) => onPlaybackProgressChange({
                clipId: activeClip.id,
                currentTime: event.currentTarget.currentTime,
                duration: event.currentTarget.duration,
              })}
            />
            <button className="video-toggle" aria-label={isUserPaused || isWaitingForNext ? '播放' : '暂停'} onClick={onTogglePlayback}>
              {isUserPaused || isWaitingForNext ? <Play size={19} fill="currentColor" /> : <Pause size={19} fill="currentColor" />}
            </button>
            <div className="video-progress" aria-label="视频播放进度">
              <span>{formatTime(activeProgress.currentTime)}</span>
              <div className="video-progress-track">
                <div className="video-progress-fill" style={{ width: `${progressPercent}%` }} />
                <input
                  type="range"
                  min="0"
                  max={activeProgress.duration || 1}
                  step="0.1"
                  value={Math.min(activeProgress.currentTime, activeProgress.duration || 0)}
                  aria-label="调整视频播放进度"
                  onChange={(event) => {
                    const nextTime = Number(event.target.value)
                    if (!videoRef.current) return
                    videoRef.current.currentTime = nextTime
                    onPlaybackProgressChange({ ...activeProgress, currentTime: nextTime })
                  }}
                />
              </div>
              <span>{formatTime(activeProgress.duration)}</span>
            </div>
            <span className="on-air"><span /> {isWaitingForNext ? 'WAITING' : isUserPaused ? 'PAUSED' : 'PLAYING'} · CLIP {activeIndex + 1}</span>
            {isWaitingForNext && (
              <div className="waiting-overlay">
                {waitingFailure ? <X size={20} /> : <LoaderCircle className="spin" size={20} />}
                <strong>{waitingFailure ? `片段 ${activeIndex + 2} 生成失败` : '等待下一段'}</strong>
                <span>{waitingFailure ? '请在时间轴中重试' : '生成完成后将自动继续播放'}</span>
              </div>
            )}
          </>
        ) : activeFailure ? (
          <div className="empty-player">
            <span className="empty-player-icon"><X size={22} /></span>
            <strong>视频生成失败</strong>
            <span className="empty-player-error">{activeFailure.error ?? '请在时间轴中重试'}</span>
          </div>
        ) : clips.length > 0 ? (
          <div className="empty-player">
            <LoaderCircle className="spin" size={25} />
            <strong>正在生成第一段视频</strong>
            <span>完成后会在这里自动播放</span>
          </div>
        ) : (
          <div className="empty-player">
            <span className="empty-player-icon">{hasActiveProject ? <Play size={22} /> : <FolderPlus size={22} />}</span>
            <strong>{hasActiveProject ? '创建你的第一个片段' : '先创建一个项目'}</strong>
            <span>{hasActiveProject ? '在右侧输入 Prompt，开始连续视频测试' : '视频与 Prompt 会保存在对应项目中'}</span>
          </div>
        )}
      </div>

      <div className="timeline-card">
        <div className="timeline-header">
          <div className="timeline-title"><Clock3 size={15} /> 时间轴</div>
          <span>{clips.length} 个片段</span>
        </div>
        <div className="timeline-track">
          {clips.length === 0 ? (
            <div className="timeline-empty"><Plus size={15} /> 生成的视频片段会依次出现在这里</div>
          ) : clips.map((clip, index) => (
            <div className="timeline-item-wrap" key={clip.id}>
              {index > 0 && <ChevronRight className="timeline-arrow" size={14} />}
              {clip.status === 'failed' ? (
                <div className="timeline-item failed" title={clip.error ?? clip.prompt}>
                  <span className="failed-label">生成失败</span>
                  <button className="retry-button" type="button" onClick={() => onRetryClip(clip.id)}>
                    <RotateCcw size={12} />重试
                  </button>
                </div>
              ) : (
                <button
                  className={`timeline-item ${index === activeIndex && ['ready', 'playing', 'completed'].includes(clip.status) ? 'selected' : ''} ${clip.status}`}
                  onClick={() => onSelectClip(index)}
                  disabled={['queued', 'generating'].includes(clip.status)}
                  title={clip.prompt}
                >
                  {clip.status === 'queued' || clip.status === 'generating' ? (
                    <>
                      <span className="skeleton" />
                      <span className="timeline-meta">
                        {clip.status === 'generating' && <LoaderCircle className="spin" size={12} />}
                        {clip.retryCount
                          ? clip.status === 'generating' ? '重新生成中' : '等待重试'
                          : clip.status === 'generating' ? '生成中' : '等待生成'}
                      </span>
                    </>
                  ) : (
                    <>
                      {clip.thumbnailUrl
                        ? <img src={clip.thumbnailUrl} alt="" />
                        : <video src={clip.videoUrl} muted playsInline preload="metadata" />}
                      <span className="timeline-meta">
                        {index === activeIndex ? <Play size={11} fill="currentColor" /> : null}
                        片段 {index + 1}
                      </span>
                    </>
                  )}
                </button>
              )}
              {['ready', 'completed'].includes(clip.status) && clip.videoUrl && (
                <button className="clip-download-button" aria-label={`下载片段 ${index + 1}`} title={`下载片段 ${index + 1}`} onClick={() => onDownloadClip(index)}>
                  <Download size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
