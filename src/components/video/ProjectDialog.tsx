import { FolderPlus, X } from 'lucide-react'
import { FormEvent } from 'react'

type ProjectDialogProps = {
  projectName: string
  nextProjectNumber: number
  onProjectNameChange: (name: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent) => void
}

export function ProjectDialog({
  projectName,
  nextProjectNumber,
  onProjectNameChange,
  onClose,
  onSubmit,
}: ProjectDialogProps) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="project-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon"><FolderPlus size={18} /></div>
          <div><h2 id="project-title">创建项目</h2><p>为这组连续视频建立独立工作空间</p></div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={onSubmit}>
          <label htmlFor="project-name">项目名称</label>
          <input
            id="project-name"
            value={projectName}
            onChange={(event) => onProjectNameChange(event.target.value)}
            placeholder={`未命名项目 ${nextProjectNumber}`}
            maxLength={60}
            autoFocus
          />
          <div className="dialog-actions">
            <button className="button button-ghost" type="button" onClick={onClose}>取消</button>
            <button className="button button-primary" type="submit">创建并进入</button>
          </div>
        </form>
      </div>
    </div>
  )
}
