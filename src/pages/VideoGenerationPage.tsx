import { FormEvent, useMemo, useState } from 'react'
import { ProjectDialog } from '../components/video/ProjectDialog'
import { ProjectSidebar } from '../components/video/ProjectSidebar'
import { VideoComposer } from '../components/video/VideoComposer'
import { VideoStage } from '../components/video/VideoStage'
import { useProjects } from '../hooks/useProjects'
import { useVideoQueue } from '../hooks/useVideoQueue'
import { createFalVideoGenerator } from '../services/falVideoGenerator'
import { mockVideoGenerator } from '../services/mockVideoGenerator'
import {
  downloadClip,
  exportProject,
  getProjectExportDisabledReason,
} from '../services/videoDownload'
import { parseSerialPrompts } from '../utils/parseSerialPrompts'

type VideoGenerationPageProps = {
  savedApiKey: string
  onRequestApiKey: () => void
}

export function VideoGenerationPage({ savedApiKey, onRequestApiKey }: VideoGenerationPageProps) {
  const [isSerialMode, setIsSerialMode] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [serialPrompt, setSerialPrompt] = useState('')
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false)
  const [projectName, setProjectName] = useState('')
  const [exportingProjectId, setExportingProjectId] = useState('')
  const [exportProgress, setExportProgress] = useState(0)
  const [notice, setNotice] = useState('')
  const [playbackProgress, setPlaybackProgress] = useState({ clipId: '', currentTime: 0, duration: 0 })
  const videoGenerator = useMemo(
    () => savedApiKey ? createFalVideoGenerator(savedApiKey) : mockVideoGenerator,
    [savedApiKey],
  )
  const projectsState = useProjects()
  const {
    projects, activeProject, activeProjectId, createProject,
    selectProject, addClips, updateClip,
  } = projectsState
  const queue = useVideoQueue({
    projectId: activeProjectId,
    clips: activeProject?.clips ?? [],
    generator: videoGenerator,
    addClips,
    updateClip,
  })
  const serialPromptResult = useMemo(() => parseSerialPrompts(serialPrompt), [serialPrompt])
  const canSubmitPrompt = isSerialMode
    ? Boolean(serialPrompt.trim() && !serialPromptResult.error && serialPromptResult.prompts.length)
    : Boolean(prompt.trim())
  const queueStatus = [
    queue.generatingCount ? `${queue.generatingCount} 个生成中` : '',
    queue.queuedCount ? `${queue.queuedCount} 个等待中` : '',
  ].filter(Boolean).join(' · ')
  const activePrompt = queue.activeClip && ['ready', 'playing', 'completed'].includes(queue.activeClip.status)
    ? queue.activeClip.prompt
    : undefined

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmitPrompt) return
    if (!activeProject) {
      setIsProjectDialogOpen(true)
      return
    }
    if (!savedApiKey) {
      onRequestApiKey()
      return
    }
    if (isSerialMode) {
      queue.enqueueBatch(serialPromptResult.prompts)
      setSerialPrompt('')
    } else {
      queue.enqueue(prompt.trim())
      setPrompt('')
    }
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
    const clip = queue.clips[index]
    if (!clip) return
    const usedFallback = await downloadClip(clip, index)
    if (usedFallback) setNotice('浏览器阻止了跨域下载，已在新窗口打开视频，可从那里保存。')
  }

  return (
    <div className="app-body">
      <ProjectSidebar
        projects={projects}
        activeProjectId={activeProjectId}
        exportingProjectId={exportingProjectId}
        exportProgress={exportProgress}
        notice={notice}
        onCreate={() => setIsProjectDialogOpen(true)}
        onSelect={selectProject}
        onExport={(projectId) => void handleProjectExport(projectId)}
      />
      <main className="workspace">
        <VideoStage
          clips={queue.clips}
          activeClip={queue.activeClip}
          activeIndex={queue.activeIndex}
          hasActiveProject={Boolean(activeProject)}
          isUserPaused={queue.isUserPaused}
          isWaitingForNext={queue.isWaitingForNext}
          queueStatus={queueStatus}
          playbackProgress={playbackProgress}
          videoRef={queue.videoRef}
          onPlaybackProgressChange={setPlaybackProgress}
          onEnded={queue.handleEnded}
          onPlay={queue.handlePlay}
          onPause={queue.handlePause}
          onTogglePlayback={queue.togglePlayback}
          onSelectClip={queue.selectClip}
          onRetryClip={queue.retryClip}
          onDownloadClip={(index) => void handleClipDownload(index)}
        />
        <VideoComposer
          isSerialMode={isSerialMode}
          prompt={prompt}
          serialPrompt={serialPrompt}
          serialPromptCount={serialPromptResult.prompts.length}
          serialPromptError={serialPromptResult.error}
          canSubmit={canSubmitPrompt}
          hasActiveProject={Boolean(activeProject)}
          hasApiKey={Boolean(savedApiKey)}
          activePrompt={activePrompt}
          onModeChange={setIsSerialMode}
          onPromptChange={setPrompt}
          onSerialPromptChange={setSerialPrompt}
          onSubmit={submitPrompt}
        />
      </main>
      {isProjectDialogOpen && (
        <ProjectDialog
          projectName={projectName}
          nextProjectNumber={projects.length + 1}
          onProjectNameChange={setProjectName}
          onClose={() => setIsProjectDialogOpen(false)}
          onSubmit={submitProject}
        />
      )}
    </div>
  )
}
