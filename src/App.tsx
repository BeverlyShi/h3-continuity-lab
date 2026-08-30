import {
  Check,
  ChevronRight,
  Clock3,
  Film,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react'
import { FormEvent, useMemo, useState } from 'react'
import { useVideoQueue } from './hooks/useVideoQueue'
import { createFalVideoGenerator } from './services/falVideoGenerator'
import { mockVideoGenerator } from './services/mockVideoGenerator'
import { VIDEO_DURATION } from './types/video'
import {
  MAX_PROMPT_LENGTH,
  MAX_SERIAL_PROMPTS,
  parseSerialPrompts,
} from './utils/parseSerialPrompts'

type PromptMode = 'single' | 'serial'

const MAX_SERIAL_INPUT_LENGTH = 12000

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

function App() {
  const [promptMode, setPromptMode] = useState<PromptMode>('single')
  const [prompt, setPrompt] = useState('')
  const [serialPrompt, setSerialPrompt] = useState('')
  const [isApiDialogOpen, setIsApiDialogOpen] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [savedApiKey, setSavedApiKey] = useState('')
  const [playbackProgress, setPlaybackProgress] = useState({
    clipId: '',
    currentTime: 0,
    duration: 0,
  })
  const videoGenerator = useMemo(
    () => savedApiKey ? createFalVideoGenerator(savedApiKey) : mockVideoGenerator,
    [savedApiKey],
  )
  const {
    clips,
    activeClip,
    activeIndex,
    queuedCount,
    generatingCount,
    videoRef,
    isUserPaused,
    isWaitingForNext,
    enqueue,
    enqueueBatch,
    retryClip,
    handleEnded,
    handlePlay,
    handlePause,
    selectClip,
    togglePlayback,
  } = useVideoQueue(videoGenerator)

  const serialPromptResult = useMemo(
    () => parseSerialPrompts(serialPrompt),
    [serialPrompt],
  )
  const isSerialMode = promptMode === 'serial'
  const canSubmitPrompt = isSerialMode
    ? Boolean(serialPrompt.trim() && !serialPromptResult.error && serialPromptResult.prompts.length)
    : Boolean(prompt.trim())

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmitPrompt) return
    if (!savedApiKey) {
      setIsApiDialogOpen(true)
      return
    }

    if (isSerialMode) {
      enqueueBatch(serialPromptResult.prompts)
      setSerialPrompt('')
    } else {
      enqueue(prompt.trim())
      setPrompt('')
    }
  }

  const saveApiKey = (event: FormEvent) => {
    event.preventDefault()
    setSavedApiKey(apiKey.trim())
    setIsApiDialogOpen(false)
  }

  const hasPlayableActiveClip = Boolean(
    activeClip && ['ready', 'playing', 'completed'].includes(activeClip.status),
  )
  const activeFailure = activeClip?.status === 'failed' ? activeClip : undefined
  const nextPlayableClip = clips[activeIndex + 1]
  const waitingFailure = isWaitingForNext && nextPlayableClip?.status === 'failed'
  const shouldPreloadNext = Boolean(
    nextPlayableClip && ['ready', 'playing', 'completed'].includes(nextPlayableClip.status),
  )
  const activeProgress = playbackProgress.clipId === activeClip?.id
    ? playbackProgress
    : { clipId: activeClip?.id ?? '', currentTime: 0, duration: 0 }
  const progressPercent = activeProgress.duration
    ? Math.min(100, (activeProgress.currentTime / activeProgress.duration) * 100)
    : 0
  const queueStatus = [
    generatingCount ? `${generatingCount} 个生成中` : '',
    queuedCount ? `${queuedCount} 个等待中` : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Film size={16} /></span>
          <span>H3 Continuity Lab</span>
          <span className="badge">Prototype</span>
        </div>
        <button className="button button-secondary" onClick={() => setIsApiDialogOpen(true)}>
          {savedApiKey ? <Check size={16} /> : <KeyRound size={16} />}
          {savedApiKey ? 'API 已配置' : '设置 API Key'}
        </button>
      </header>

      <main className="workspace">
        <section className="stage-column">
          <div className="section-heading">
            <div>
              <h1>连续视频预览</h1>
              <p>片段生成后会自动加入播放队列</p>
            </div>
            <div className="status-line">
              <span className={queueStatus ? 'status-dot status-dot-busy' : 'status-dot'} />
              {queueStatus || (clips.length ? '队列已同步' : '等待首个 Prompt')}
            </div>
          </div>

          <div className="player-frame">
            {hasPlayableActiveClip && activeClip ? (
              <>
                {shouldPreloadNext && nextPlayableClip?.videoUrl && (
                  <video
                    className="video-preload"
                    src={nextPlayableClip.videoUrl}
                    preload="auto"
                    muted
                    playsInline
                    aria-hidden="true"
                  />
                )}
                <video
                  ref={videoRef}
                  key={activeClip.id}
                  src={activeClip.videoUrl}
                  poster={activeClip.thumbnailUrl}
                  playsInline
                  onEnded={handleEnded}
                  onPlay={handlePlay}
                  onPause={handlePause}
                  onLoadedMetadata={(event) => {
                    setPlaybackProgress({
                      clipId: activeClip.id,
                      currentTime: event.currentTarget.currentTime,
                      duration: event.currentTarget.duration,
                    })
                  }}
                  onTimeUpdate={(event) => {
                    setPlaybackProgress({
                      clipId: activeClip.id,
                      currentTime: event.currentTarget.currentTime,
                      duration: event.currentTarget.duration,
                    })
                  }}
                />
                <button className="video-toggle" aria-label={isUserPaused || isWaitingForNext ? '播放' : '暂停'} onClick={togglePlayback}>
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
                        setPlaybackProgress((current) => ({ ...current, currentTime: nextTime }))
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
                <span className="empty-player-error">
                  {activeFailure.error ?? '请在时间轴中重试'}
                </span>
              </div>
            ) : clips.length > 0 ? (
              <div className="empty-player">
                <LoaderCircle className="spin" size={25} />
                <strong>正在生成第一段视频</strong>
                <span>完成后会在这里自动播放</span>
              </div>
            ) : (
              <div className="empty-player">
                <span className="empty-player-icon"><Play size={22} /></span>
                <strong>创建你的第一个片段</strong>
                <span>在右侧输入 Prompt，开始连续视频测试</span>
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
              ) : (
                clips.map((clip, index) => (
                  <div className="timeline-item-wrap" key={clip.id}>
                    {index > 0 && <ChevronRight className="timeline-arrow" size={14} />}
                    {clip.status === 'failed' ? (
                      <div className="timeline-item failed" title={clip.error ?? clip.prompt}>
                        <span className="failed-label">生成失败</span>
                        <button
                          className="retry-button"
                          type="button"
                          onClick={() => retryClip(clip.id)}
                        >
                          <RotateCcw size={12} />
                          重试
                        </button>
                      </div>
                    ) : (
                      <button
                        className={`timeline-item ${index === activeIndex && ['ready', 'playing', 'completed'].includes(clip.status) ? 'selected' : ''} ${clip.status}`}
                        onClick={() => selectClip(index)}
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
                          {clip.thumbnailUrl ? (
                            <img src={clip.thumbnailUrl} alt="" />
                          ) : (
                            <video src={clip.videoUrl} muted playsInline preload="metadata" />
                          )}
                          <span className="timeline-meta">
                            {index === activeIndex ? <Play size={11} fill="currentColor" /> : null}
                            片段 {index + 1}
                          </span>
                        </>
                      )}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        <aside className="side-panel">
          <section className="card current-prompt-card">
            <div className="card-label"><span className="live-indicator" /> 当前 Prompt</div>
            <p className={hasPlayableActiveClip ? '' : 'muted'}>
              {hasPlayableActiveClip
                ? activeClip?.prompt
                : '播放开始后，当前片段的 Prompt 会显示在这里。'}
            </p>
          </section>

          <section className="card composer-card">
            <div className="card-heading">
              <div>
                <h2>创建视频片段</h2>
                <p>每个片段固定生成 {VIDEO_DURATION} 秒</p>
              </div>
              <Sparkles size={17} />
            </div>
            <form onSubmit={submitPrompt}>
              <div className="prompt-tabs" role="tablist" aria-label="Prompt 输入模式">
                <button
                  className={!isSerialMode ? 'active' : ''}
                  type="button"
                  role="tab"
                  aria-selected={!isSerialMode}
                  onClick={() => setPromptMode('single')}
                >
                  单个 Prompt
                </button>
                <button
                  className={isSerialMode ? 'active' : ''}
                  type="button"
                  role="tab"
                  aria-selected={isSerialMode}
                  onClick={() => setPromptMode('serial')}
                >
                  串行 Prompt
                </button>
              </div>
              <label htmlFor="prompt">{isSerialMode ? '串行 Prompt' : 'Prompt'}</label>
              <textarea
                id="prompt"
                className={isSerialMode ? 'serial-prompt-input' : ''}
                value={isSerialMode ? serialPrompt : prompt}
                onChange={(event) => {
                  if (isSerialMode) setSerialPrompt(event.target.value)
                  else setPrompt(event.target.value)
                }}
                placeholder={isSerialMode
                  ? 'Prompt 1: 镜头缓慢推进，穿过雾气……\n\nPrompt 2: 城市上空出现一艘飞船……'
                  : '例如：镜头缓慢推进，穿过雾气，一座发光的城市出现在山谷中……'}
                maxLength={isSerialMode ? MAX_SERIAL_INPUT_LENGTH : MAX_PROMPT_LENGTH}
                rows={isSerialMode ? 9 : 7}
                aria-describedby="prompt-feedback"
              />
              <div className="composer-footer">
                <span
                  id="prompt-feedback"
                  className={isSerialMode && serialPromptResult.error ? 'prompt-error' : ''}
                >
                  {isSerialMode
                    ? serialPromptResult.error ?? `已识别 ${serialPromptResult.prompts.length} / ${MAX_SERIAL_PROMPTS} 个 Prompt`
                    : `${prompt.length} / ${MAX_PROMPT_LENGTH}`}
                </span>
                <button className="button button-primary" type="submit" disabled={!canSubmitPrompt}>
                  <Sparkles size={16} />
                  {isSerialMode && serialPromptResult.prompts.length
                    ? `将 ${serialPromptResult.prompts.length} 个 Prompt 加入队列`
                    : '加入生成队列'}
                </button>
              </div>
            </form>
          </section>

          <div className="mock-note">
            <Settings2 size={15} />
            <div>
              <strong>{savedApiKey ? 'fal H3 Max 已连接' : '等待连接 fal API'}</strong>
              <span>{savedApiKey ? '新片段将使用真实 API 生成' : '设置 API Key 后即可开始生成'}</span>
            </div>
          </div>
        </aside>
      </main>

      {isApiDialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setIsApiDialogOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-heading">
              <div className="dialog-icon"><KeyRound size={18} /></div>
              <div><h2 id="api-title">连接 fal API</h2><p>API Key 仅保留在当前浏览器会话中</p></div>
              <button className="icon-button" aria-label="关闭" onClick={() => setIsApiDialogOpen(false)}><X size={17} /></button>
            </div>
            <form onSubmit={saveApiKey}>
              <label htmlFor="api-key">FAL_KEY</label>
              <div className="input-with-icon">
                <LockKeyhole size={15} />
                <input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="粘贴你的 FAL_KEY"
                  autoComplete="off"
                  autoFocus
                />
              </div>
              <div className="security-note">原型不会把 Key 写入代码或永久存储。正式接入时应通过服务端代理调用。</div>
              <div className="dialog-actions">
                <button className="button button-ghost" type="button" onClick={() => setIsApiDialogOpen(false)}>取消</button>
                <button className="button button-primary" type="submit" disabled={!apiKey.trim()}>保存设置</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
