import { FormEvent, useEffect, useRef, useState } from 'react'
import { Bot, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import type { DirectorChatMessage, DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'
import type { DirectorAgentKind } from '../../services/directorClient'

const agentOptions: Array<{ value: DirectorAgentKind; label: string; caption: string }> = [
  { value: 'pi', label: 'Pi 故事导演', caption: 'Pi Agent · DeepSeek · thinking off' },
  { value: 'simple', label: '极简导演', caption: '裸 DeepSeek API · 单次调用' },
]

type AgentChatProps = {
  session: GameSession | null
  agentKind: DirectorAgentKind
  onAgentKindChange: (kind: DirectorAgentKind) => void
  messages: DirectorChatMessage[]
  status: DirectorStatus
  hasApiKey: boolean
  onSubmit: (text: string) => boolean
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
  messages,
  status,
  hasApiKey,
  onSubmit,
  onRetry,
  onRequestApiKey,
}: AgentChatProps) {
  const [text, setText] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const canAct = session?.status === 'awaiting_action' && status === 'idle'
  const canRetry = hasApiKey && !['thinking', 'publishing'].includes(status)
    && session?.status === 'awaiting_agent'

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim() || !canAct) return
    if (onSubmit(text.trim())) setText('')
  }

  return (
    <section className="agent-chat-card">
      <header className="agent-chat-heading">
        <div>
          <span className="agent-avatar"><Bot size={15} /></span>
          <div>
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
            <p>{agentOptions.find((option) => option.value === agentKind)?.caption}</p>
          </div>
        </div>
        <span className={`agent-status ${status}`}>
          {status === 'thinking' || status === 'publishing' ? <LoaderCircle className="spin" size={11} /> : null}
          {statusLabel[status]}
        </span>
      </header>

      <div className="agent-message-list" aria-live="polite">
        {!messages.length && (
          <div className="agent-empty">
            <Bot size={19} />
            <p>{hasApiKey
              ? '我会主动展开故事，并在每回合通过 publish_scene 给出新的场景与选择。'
              : '配置 DeepSeek API Key 后，我会接管每一幕的推进。'}</p>
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
        <button className="button button-secondary agent-key-button" onClick={onRequestApiKey}>配置 DeepSeek Key</button>
      ) : canRetry ? (
        <button className="button button-secondary agent-key-button" onClick={onRetry}>
          <RotateCcw size={14} />重试当前回合
        </button>
      ) : (
        <form className="agent-chat-form" onSubmit={submit}>
          <textarea
            value={text}
            maxLength={500}
            disabled={!canAct}
            placeholder={canAct ? '也可以在这里输入自由行动…' : '等待 Pi 导演发布场景'}
            onChange={(event) => setText(event.target.value)}
          />
          <button aria-label="发送行动" disabled={!canAct || !text.trim()} type="submit"><Send size={14} /></button>
        </form>
      )}
    </section>
  )
}
