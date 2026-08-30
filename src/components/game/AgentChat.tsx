import { FormEvent, useEffect, useRef, useState } from 'react'
import { Bot, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import type { DirectorChatMessage, DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'

type AgentChatProps = {
  session: GameSession | null
  messages: DirectorChatMessage[]
  status: DirectorStatus
  hasApiKey: boolean
  onSubmit: (text: string) => boolean
  onRetry: () => void
  onRequestApiKey: () => void
}

const statusLabel: Record<DirectorStatus, string> = {
  idle: '待命',
  thinking: '裁决中',
  publishing: '发布文字',
  error: '需要处理',
}

export function AgentChat({
  session,
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
    && session?.status === 'awaiting_director'

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
        <div><span className="agent-avatar"><Bot size={15} /></span><div><h2>Pi 世界导演</h2><p>DeepSeek V4 Flash</p></div></div>
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
              ? '我会自动接收你的选择、裁决世界状态，并直接发布下一幕文字。'
              : '配置 DeepSeek API Key 后，我会自动推进每个回合。'}</p>
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
          <RotateCcw size={14} />重试当前步骤
        </button>
      ) : (
        <form className="agent-chat-form" onSubmit={submit}>
          <textarea
            value={text}
            maxLength={500}
            disabled={!canAct}
            placeholder={canAct ? '也可以在这里输入自由行动…' : '等待当前场景播放或生成完成'}
            onChange={(event) => setText(event.target.value)}
          />
          <button aria-label="发送行动" disabled={!canAct || !text.trim()} type="submit"><Send size={14} /></button>
        </form>
      )}
    </section>
  )
}
