import {
  Check,
  ChevronRight,
  Clock3,
  Download,
  Film,
  FolderOpen,
  FolderPlus,
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
import { useProjects } from './hooks/useProjects'
import { useVideoQueue } from './hooks/useVideoQueue'
import { createFalVideoGenerator } from './services/falVideoGenerator'
import { mockVideoGenerator } from './services/mockVideoGenerator'
import { loadApiKey, saveApiKey as persistApiKey } from './services/localStorage'
import {
  canExportProject,
  downloadClip,
  exportProject,
  getProjectExportDisabledReason,
} from './services/videoDownload'
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
  const [savedApiKey, setSavedApiKey] = useState(loadApiKey)
  const [apiKey, setApiKey] = useState(loadApiKey)
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [exportingProjectId, setExportingProjectId] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [notice, setNotice] = useState('')
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
    projects,
    activeProject,
    activeProjectId,
    createProject,
    selectProject,
    addClips,
    updateClip,
  } = useProjects()
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
  } = useVideoQueue({
    projectId: activeProjectId,
    clips: activeProject?.clips ?? [],
    generator: videoGenerator,
    addClips,
    updateClip,
  })

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
    if (!activeProject) {
      setIsProjectDialogOpen(true)
      return
    }
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
    const cleanApiKey = apiKey.trim()
    setSavedApiKey(cleanApiKey)
    persistApiKey(cleanApiKey)
    setIsApiDialogOpen(false)
  }

  const clearApiKey = () => {
    setApiKey('')
    setSavedApiKey('')
    persistApiKey('')
    setIsApiDialogOpen(false)
  }

  const submitProject = (event: FormEvent) => {
    event.preventDefault()
    createProject(projectName)
    setProjectName('')
    setIsProjectDialogOpen(false)
  }

  const handleProjectExport = async (projectId: string) => {
    const project = projects.find((item) => item.id === projectId)
    if (!project || exportingProjectId) return
    const disabledReason = getProjectExportDisabledReason(project)
    if (disabledReason) {
      setNotice(disabledReason)
      return
    }

    setNotice('')
    setExportingProjectId(projectId)
    setExportProgress(0)
    try {
      await exportProject(project, setExportProgress)
      setNotice(`“${project.name}”已合并并开始下载。`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '项目导出失败，请重试。')
    } finally {
      setExportingProjectId('')
      setExportProgress(0)
    }
  }

  const handleClipDownload = async (index: number) => {
    const clip = clips[index]
    if (!clip) return
    const usedFallback = await downloadClip(clip, index)
    if (usedFallback) setNotice('浏览器阻止了跨域下载，已在新窗口打开视频，可从那里保存。')
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

      <div className="app-body">
        <aside className="project-sidebar" aria-label="项目列表">
          <div className="project-sidebar-header">
            <span>项目</span>
            <button
              className="project-create-button"
              onClick={() => setIsProjectDialogOpen(true)}
            >
              <FolderPlus size={16} />
              创建项目
            </button>
          </div>
          <div className="project-list">
            {projects.length === 0 ? (
              <div className="project-empty">
                <FolderOpen size={22} />
                <span>还没有项目</span>
                <small>创建项目后开始生成视频</small>
              </div>
            ) : projects.map((project) => {
              const isExporting = exportingProjectId === project.id
              const exportReason = getProjectExportDisabledReason(project)
              return (
                <div
                  className={`project-item ${project.id === activeProjectId ? 'active' : ''}`}
                  key={project.id}
                >
                  <button
                    className="project-select-button"
                    onClick={() => selectProject(project.id)}
                    title={project.name}
                  >
                    <FolderOpen size={15} />
                    <span>{project.name}</span>
                  </button>
                  <button
                    className="project-download-button"
                    aria-label={`下载项目 ${project.name}`}
                    title={isExporting ? `正在导出 ${exportProgress}%` : exportReason || '下载整个项目'}
                    disabled={Boolean(exportingProjectId) || !canExportProject(project)}
                    onClick={() => void handleProjectExport(project.id)}
                  >
                    {isExporting ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}
                  </button>
                </div>
              )
            })}
          </div>
          {notice && <div className="workspace-notice" role="status">{notice}</div>}
          {exportingProjectId && (
            <div className="export-progress" role="status">
              <div><span>正在合并项目</span><strong>{exportProgress}%</strong></div>
              <progress value={exportProgress} max="100" />
            </div>
          )}
        </aside>

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
                <span className="empty-player-icon">{activeProject ? <Play size={22} /> : <FolderPlus size={22} />}</span>
                <strong>{activeProject ? '创建你的第一个片段' : '先创建一个项目'}</strong>
                <span>{activeProject ? '在右侧输入 Prompt，开始连续视频测试' : '视频与 Prompt 会保存在对应项目中'}</span>
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
                    {['ready', 'completed'].includes(clip.status) && clip.videoUrl && (
                      <button
                        className="clip-download-button"
                        aria-label={`下载片段 ${index + 1}`}
                        title={`下载片段 ${index + 1}`}
                        onClick={() => void handleClipDownload(index)}
                      >
                        <Download size={13} />
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
                  {!activeProject
                    ? '先创建项目'
                    : isSerialMode && serialPromptResult.prompts.length
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
      </div>

      {isProjectDialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setIsProjectDialogOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-heading">
              <div className="dialog-icon"><FolderPlus size={18} /></div>
              <div><h2 id="project-title">创建项目</h2><p>为这组连续视频建立独立工作空间</p></div>
              <button className="icon-button" aria-label="关闭" onClick={() => setIsProjectDialogOpen(false)}><X size={17} /></button>
            </div>
            <form onSubmit={submitProject}>
              <label htmlFor="project-name">项目名称</label>
              <input
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder={`未命名项目 ${projects.length + 1}`}
                maxLength={60}
                autoFocus
              />
              <div className="dialog-actions">
                <button className="button button-ghost" type="button" onClick={() => setIsProjectDialogOpen(false)}>取消</button>
                <button className="button button-primary" type="submit">创建并进入</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isApiDialogOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={() => setIsApiDialogOpen(false)}>
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-heading">
              <div className="dialog-icon"><KeyRound size={18} /></div>
              <div><h2 id="api-title">连接 fal API</h2><p>API Key 将保存在当前浏览器和设备</p></div>
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
              <div className="security-note">Key 会明文保存在浏览器 localStorage 中，不会写入源码。共享设备上请及时清除；正式产品应通过服务端代理调用。</div>
              <div className="dialog-actions">
                {savedApiKey && <button className="button button-danger" type="button" onClick={clearApiKey}>清除 Key</button>}
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
