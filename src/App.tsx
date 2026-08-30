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
import { MAX_VIDEO_DURATION, MIN_VIDEO_DURATION } from './types/video'

const formatTime = (seconds: number) => {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`
}

function App() {
  const [prompt, setPrompt] = useState('')
  const [duration, setDuration] = useState(MIN_VIDEO_DURATION)
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
    addClip,
    updateClip,
  } = useProjects()
  const {
    clips,
    activeClip,
    activeIndex,
    queuedCount,
    videoRef,
    isUserPaused,
    isWaitingForNext,
    enqueue,
    handleEnded,
    handlePlay,
    handlePause,
    selectClip,
    togglePlayback,
  } = useVideoQueue({
    projectId: activeProjectId,
    clips: activeProject?.clips ?? [],
    generator: videoGenerator,
    addClip,
    updateClip,
  })

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault()
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) return
    if (!activeProject) {
      setIsProjectDialogOpen(true)
      return
    }
    if (!savedApiKey) {
      setIsApiDialogOpen(true)
      return
    }

    enqueue(cleanPrompt, duration)
    setPrompt('')
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
  const latestClip = clips[clips.length - 1]
  const latestFailure = latestClip?.status === 'failed' ? latestClip : undefined
  const nextPlayableClip = clips[activeIndex + 1]
  const shouldPreloadNext = Boolean(
    nextPlayableClip && ['ready', 'playing', 'completed'].includes(nextPlayableClip.status),
  )
  const activeProgress = playbackProgress.clipId === activeClip?.id
    ? playbackProgress
    : { clipId: activeClip?.id ?? '', currentTime: 0, duration: 0 }
  const progressPercent = activeProgress.duration
    ? Math.min(100, (activeProgress.currentTime / activeProgress.duration) * 100)
    : 0

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
              <span className={queuedCount ? 'status-dot status-dot-busy' : 'status-dot'} />
              {queuedCount ? `${queuedCount} 个片段生成中` : clips.length ? '队列已同步' : '等待首个 Prompt'}
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
                    <LoaderCircle className="spin" size={20} />
                    <strong>等待下一段</strong>
                    <span>生成完成后将自动继续播放</span>
                  </div>
                )}
              </>
            ) : latestFailure ? (
              <div className="empty-player">
                <span className="empty-player-icon"><X size={22} /></span>
                <strong>视频生成失败</strong>
                <span className="empty-player-error">
                  {latestFailure.error ?? '请检查 API Key 后重试'}
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
                    <button
                      className={`timeline-item ${index === activeIndex && ['ready', 'playing', 'completed'].includes(clip.status) ? 'selected' : ''} ${clip.status}`}
                      onClick={() => selectClip(index)}
                      disabled={['queued', 'generating', 'failed'].includes(clip.status)}
                      title={clip.error ?? clip.prompt}
                    >
                      {clip.status === 'queued' || clip.status === 'generating' ? (
                        <>
                          <span className="skeleton" />
                          <span className="timeline-meta"><LoaderCircle className="spin" size={12} /> 生成中</span>
                        </>
                      ) : clip.status === 'failed' ? (
                        <span className="timeline-meta">生成失败</span>
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
                <h2>{clips.length ? '生成下一段' : '生成第一段'}</h2>
                <p>描述接下来镜头中发生的内容</p>
              </div>
              <Sparkles size={17} />
            </div>
            <form onSubmit={submitPrompt}>
              <div className="form-label-row">
                <label htmlFor="prompt">Prompt</label>
                <label className="duration-control" htmlFor="duration">
                  <span>时长</span>
                  <select
                    id="duration"
                    value={duration}
                    onChange={(event) => setDuration(Number(event.target.value))}
                  >
                    {Array.from(
                      { length: MAX_VIDEO_DURATION - MIN_VIDEO_DURATION + 1 },
                      (_, index) => MIN_VIDEO_DURATION + index,
                    ).map((seconds) => (
                      <option key={seconds} value={seconds}>{seconds} 秒</option>
                    ))}
                  </select>
                </label>
              </div>
              <textarea
                id="prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="例如：镜头缓慢推进，穿过雾气，一座发光的城市出现在山谷中……"
                maxLength={1000}
                rows={7}
              />
              <div className="composer-footer">
                <span>{prompt.length} / 1000</span>
                <button className="button button-primary" type="submit" disabled={!prompt.trim()}>
                  <Sparkles size={16} />
                  {activeProject ? '加入生成队列' : '先创建项目'}
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
