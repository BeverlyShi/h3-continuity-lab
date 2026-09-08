import { useEffect, useRef } from 'react'
import { Bot, LoaderCircle, RotateCcw } from 'lucide-react'
import type { DirectorChatMessage, DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'
import type { DirectorAgentKind } from '../../services/directorClient'
import { directorModelOptions, type DirectorModelId } from '../../config/directorModels'
import { isDirectorActive } from '../../services/directorStatus'

const agentOptions: Array<{ value: DirectorAgentKind; label: string; caption: string }> = [
  { value: 'pi', label: 'Pi 故事导演', caption: 'Pi Agent · OpenRouter · thinking off' },
  { value: 'simple', label: '极简导演', caption: 'OpenRouter · 单次调用' },
]

type AgentChatProps = {
  session: GameSession | null
  agentKind: DirectorAgentKind
  onAgentKindChange: (kind: DirectorAgentKind) => void
  modelId: DirectorModelId
  onModelChange: (modelId: DirectorModelId) => void
  thinkingEnabled: boolean
  onThinkingChange: (enabled: boolean) => void
  messages: DirectorChatMessage[]
  status: DirectorStatus
  hasApiKey: boolean
  apiKeyLabel?: string
  onRetry: () => void
  onRequestApiKey: () => void
}

const statusLabel: Record<DirectorStatus, string> = {
  idle: '待命',
  thinking: '构思中',
  publishing: '发布场景',
  error: '需要处理',
}

export function AgentChat({
  session,
  agentKind,
  onAgentKindChange,
  modelId,
  onModelChange,
  thinkingEnabled,
  onThinkingChange,
  messages,
  status,
  hasApiKey,
  apiKeyLabel = 'OpenRouter',
  onRetry,
  onRequestApiKey,
}: AgentChatProps) {
  const endRef = useRef<HTMLDivElement>(null)
  const canRetry = hasApiKey && !['thinking', 'publishing'].includes(status)
    && session?.status === 'awaiting_agent'

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <section className="agent-chat-card">
      <header className="agent-chat-heading">
        <div>
          <span className="agent-avatar"><Bot size={15} /></span>
          <div className="agent-selects">
            <select
              className="agent-kind-select"
              aria-label="切换导演 Agent"
              value={agentKind}
              disabled={['thinking', 'publishing'].includes(status)}
              onChange={(event) => onAgentKindChange(event.target.value as DirectorAgentKind)}
            >
              {agentOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              className="agent-model-select"
              aria-label="选择导演模型"
              value={modelId}
              disabled={['thinking', 'publishing'].includes(status)}
              onChange={(event) => onModelChange(event.target.value as DirectorModelId)}
            >
              {directorModelOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <p>{modelId === 'z-ai/glm-5.3-flash'
              ? '智谱官方'
              : modelId === 'deepseek-v4-flash'
              ? 'DeepSeek 官方'
              : agentOptions.find((option) => option.value === agentKind)?.caption}</p>
            {(modelId === 'deepseek-v4-flash' || modelId === 'z-ai/glm-5.3-flash') && (
              <button
                type="button"
                className="agent-thinking-toggle"
                role="switch"
                aria-label={modelId === 'z-ai/glm-5.3-flash' ? '增强思考' : '思考模式'}
                aria-checked={thinkingEnabled}
                disabled={isDirectorActive(status)}
                onClick={() => onThinkingChange(!thinkingEnabled)}
              >
                <span className="agent-thinking-track" aria-hidden="true"><span /></span>
                {modelId === 'z-ai/glm-5.3-flash'
                  ? `思考强度：${thinkingEnabled ? '增强（high）' : '轻量（low）'}`
                  : `思考模式：${thinkingEnabled ? '开启（high）' : '关闭'}`}
              </button>
            )}
            {modelId === 'z-ai/glm-5.3-flash' && <p>此模型不支持完全关闭思考</p>}
          </div>
        </div>
        <span className={`agent-status ${status}`}>
          {isDirectorActive(status) ? <LoaderCircle className="spin" size={11} /> : null}
          {statusLabel[status]}
        </span>
      </header>

      <div className="agent-message-list" aria-live="polite">
        {!messages.length && (
          <div className="agent-empty">
            <Bot size={19} />
            <p>{hasApiKey
              ? '我会根据你的选择、剧情状态和上一幕尾帧状态推进下一幕。'
              : `配置 ${apiKeyLabel} API Key 后，我会接管每一幕的推进。`}</p>
          </div>
        )}
        {messages.map((message) => (
          <div className={`agent-message ${message.role}`} key={message.id}>
            <span>{message.role === 'player' ? '你' : message.role === 'error' ? '错误' : '导演'}</span>
            <p>{message.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {!hasApiKey ? (
        <button className="button button-secondary agent-key-button" onClick={onRequestApiKey}>配置 {apiKeyLabel} Key</button>
      ) : canRetry ? (
        <button className="button button-secondary agent-key-button" onClick={onRetry}>
          <RotateCcw size={14} />重试当前回合
        </button>
      ) : null}
    </section>
  )
}
