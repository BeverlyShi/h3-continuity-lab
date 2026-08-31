import { FormEvent, useState } from 'react'
import { Bot, CheckCircle2, LoaderCircle, Send, Sparkles } from 'lucide-react'
import { unregisteredCity } from '../../stories/unregisteredCity'
import type { GameSession, PlayerAction } from '../../types/game'

type GameInteractionProps = {
  session: GameSession
  onSubmit: (text: string, source: PlayerAction['source']) => boolean
}

const waitingCopy: Partial<Record<GameSession['status'], string>> = {
  awaiting_director: '玩家行动已锁定，Pi 导演正在自动读取并裁决。',
  resolved: '规则校验已通过，正在自动请求下一段视频。',
  generating_video: 'H3 Max 正在生成导演确认的下一幕。',
  ready_to_publish: '下一幕已经生成，正在自动发布给玩家。',
}

export function GameInteraction({ session, onSubmit }: GameInteractionProps) {
  const [text, setText] = useState('')
  const [source, setSource] = useState<PlayerAction['source']>('freeform')
  const options = session.currentScene?.options ?? ['', '']

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    onSubmit(text, source)
  }

  if (session.status === 'ended' && session.currentScene?.ending) {
    return (
      <section className={`game-interaction-card ending ${session.currentScene.ending.kind}`}>
        <CheckCircle2 size={22} />
        <div><h2>{session.currentScene.ending.title}</h2><p>{session.currentScene.ending.summary}</p></div>
      </section>
    )
  }

  if (session.status !== 'awaiting_action') {
    const copy = waitingCopy[session.status]
    if (!copy) return null
    return (
      <section className="game-interaction-card waiting" aria-live="polite">
        {session.status === 'ready_to_publish'
          ? <Sparkles size={20} />
          : <LoaderCircle className={session.status === 'generating_video' ? 'spin' : ''} size={20} />}
        <div>
          <h2>{copy}</h2>
          <p>无需外部操作，完成后会自动播放下一幕。</p>
        </div>
      </section>
    )
  }

  return (
    <section className="game-interaction-card">
      <div className="game-interaction-heading">
        <div><Bot size={17} /><span>你准备怎么做？</span></div>
        <small>第 {session.turn} / {unregisteredCity.maxTurns} 回合</small>
      </div>
      <div className="game-choice-grid">
        {options.map((option) => (
          <button
            key={option}
            className={source === 'suggested' && text === option ? 'selected' : ''}
            onClick={() => { setText(option); setSource('suggested'); onSubmit(option, 'suggested') }}
          >
            {option}
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="player-action">自由行动</label>
        <textarea
          id="player-action"
          value={text}
          maxLength={500}
          placeholder="例如：我先不分配宿籍，让四个人互相指出对方隐瞒的事情……"
          onChange={(event) => { setText(event.target.value); setSource('freeform') }}
        />
        <div className="game-action-footer">
          <span>{text.length} / 500</span>
          <button className="button button-primary" disabled={!text.trim()} type="submit">
            <Send size={15} />提交行动
          </button>
        </div>
      </form>
    </section>
  )
}
