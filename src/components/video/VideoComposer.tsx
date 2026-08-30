import { Settings2, Sparkles } from 'lucide-react'
import { FormEvent } from 'react'
import { VIDEO_DURATION } from '../../types/video'
import { MAX_PROMPT_LENGTH, MAX_SERIAL_PROMPTS } from '../../utils/parseSerialPrompts'

type VideoComposerProps = {
  isSerialMode: boolean
  prompt: string
  serialPrompt: string
  serialPromptCount: number
  serialPromptError?: string
  canSubmit: boolean
  hasActiveProject: boolean
  hasApiKey: boolean
  activePrompt?: string
  onModeChange: (isSerial: boolean) => void
  onPromptChange: (prompt: string) => void
  onSerialPromptChange: (prompt: string) => void
  onSubmit: (event: FormEvent) => void
}

const MAX_SERIAL_INPUT_LENGTH = 12000

export function VideoComposer(props: VideoComposerProps) {
  const {
    isSerialMode, prompt, serialPrompt, serialPromptCount, serialPromptError,
    canSubmit, hasActiveProject, hasApiKey, activePrompt, onModeChange, onPromptChange,
    onSerialPromptChange, onSubmit,
  } = props

  return (
    <aside className="side-panel">
      <section className="card current-prompt-card">
        <div className="card-label"><span className="live-indicator" /> 当前 Prompt</div>
        <p className={activePrompt ? '' : 'muted'}>
          {activePrompt ?? '播放开始后，当前片段的 Prompt 会显示在这里。'}
        </p>
      </section>
      <section className="card composer-card">
        <div className="card-heading">
          <div><h2>创建视频片段</h2><p>每个片段固定生成 {VIDEO_DURATION} 秒</p></div>
          <Sparkles size={17} />
        </div>
        <form onSubmit={onSubmit}>
          <div className="prompt-tabs" role="tablist" aria-label="Prompt 输入模式">
            <button className={!isSerialMode ? 'active' : ''} type="button" role="tab" aria-selected={!isSerialMode} onClick={() => onModeChange(false)}>单个 Prompt</button>
            <button className={isSerialMode ? 'active' : ''} type="button" role="tab" aria-selected={isSerialMode} onClick={() => onModeChange(true)}>串行 Prompt</button>
          </div>
          <label htmlFor="prompt">{isSerialMode ? '串行 Prompt' : 'Prompt'}</label>
          <textarea
            id="prompt"
            className={isSerialMode ? 'serial-prompt-input' : ''}
            value={isSerialMode ? serialPrompt : prompt}
            onChange={(event) => isSerialMode ? onSerialPromptChange(event.target.value) : onPromptChange(event.target.value)}
            placeholder={isSerialMode
              ? 'Prompt 1: 镜头缓慢推进，穿过雾气……\n\nPrompt 2: 城市上空出现一艘飞船……'
              : '例如：镜头缓慢推进，穿过雾气，一座发光的城市出现在山谷中……'}
            maxLength={isSerialMode ? MAX_SERIAL_INPUT_LENGTH : MAX_PROMPT_LENGTH}
            rows={isSerialMode ? 9 : 7}
            aria-describedby="prompt-feedback"
          />
          <div className="composer-footer">
            <span id="prompt-feedback" className={isSerialMode && serialPromptError ? 'prompt-error' : ''}>
              {isSerialMode
                ? serialPromptError ?? `已识别 ${serialPromptCount} / ${MAX_SERIAL_PROMPTS} 个 Prompt`
                : `${prompt.length} / ${MAX_PROMPT_LENGTH}`}
            </span>
            <button className="button button-primary" type="submit" disabled={!canSubmit}>
              <Sparkles size={16} />
              {!hasActiveProject
                ? '先创建项目'
                : isSerialMode && serialPromptCount
                  ? `将 ${serialPromptCount} 个 Prompt 加入队列`
                  : '加入生成队列'}
            </button>
          </div>
        </form>
      </section>
      <div className="mock-note">
        <Settings2 size={15} />
        <div>
          <strong>{hasApiKey ? 'fal H3 Max 已连接' : '等待连接 fal API'}</strong>
          <span>{hasApiKey ? '新片段将使用真实 API 生成' : '设置 API Key 后即可开始生成'}</span>
        </div>
      </div>
    </aside>
  )
}
