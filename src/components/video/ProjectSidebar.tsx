import { Download, FolderOpen, FolderPlus, LoaderCircle } from 'lucide-react'
import { canExportProject, getProjectExportDisabledReason } from '../../services/videoDownload'
import type { VideoProject } from '../../types/video'

type ProjectSidebarProps = {
  projects: VideoProject[]
  activeProjectId: string
  exportingProjectId: string
  exportProgress: number
  notice: string
  onCreate: () => void
  onSelect: (projectId: string) => void
  onExport: (projectId: string) => void
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  exportingProjectId,
  exportProgress,
  notice,
  onCreate,
  onSelect,
  onExport,
}: ProjectSidebarProps) {
  return (
    <aside className="project-sidebar" aria-label="项目列表">
      <div className="project-sidebar-header">
        <span>项目</span>
        <button className="project-create-button" onClick={onCreate}>
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
            <div className={`project-item ${project.id === activeProjectId ? 'active' : ''}`} key={project.id}>
              <button className="project-select-button" onClick={() => onSelect(project.id)} title={project.name}>
                <FolderOpen size={15} />
                <span>{project.name}</span>
              </button>
              <button
                className="project-download-button"
                aria-label={`下载项目 ${project.name}`}
                title={isExporting ? `正在导出 ${exportProgress}%` : exportReason || '下载整个项目'}
                disabled={Boolean(exportingProjectId) || !canExportProject(project)}
                onClick={() => onExport(project.id)}
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
  )
}
