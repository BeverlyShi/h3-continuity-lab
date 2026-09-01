import { FormEvent, useState } from 'react'
import { Bot, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import { isDirectorActive } from '../../services/directorStatus'
import type { DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'
import type { StoryChoice } from '../../types/story'

type GameInteractionProps = {
  session: GameSession
  directorStatus: DirectorStatus
  onChoose: (choice: StoryChoice) => boolean
  onSubmitFreeform: (text: string) => boolean
  onRetry: () => void
}

export function GameInteraction({
  session,
  directorStatus,
  onChoose,
  onSubmitFreeform,
  onRetry,
}: GameInteractionProps) {
  const [text, setText] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text.trim()) return
    if (onSubmitFreeform(text)) setText('')
  }

  if (session.status === 'awaiting_agent') {
    if (!isDirectorActive(directorStatus)) {
      return (
        <section className="game-interaction-card waiting recoverable" aria-live="polite">
          <RotateCcw size={20} />
          <div>
            <h2>上次续写已中断</h2>
            <p>玩家输入仍已保存，可以让 Pi Agent 重试本回合。</p>
          </div>
          <button className="button button-secondary" onClick={onRetry}>重试当前回合</button>
        </section>
      )
    }
    return (
      <section className="game-interaction-card waiting" aria-live="polite">
        <LoaderCircle className="spin" size={20} />
        <div>
          <h2>Pi 导演正在续写故事</h2>
          <p>模型会通过 publish_scene 发布下一幕、选择和视频计划。</p>
        </div>
      </section>
    )
  }

  if (isDirectorActive(directorStatus)) {
    return (
      <section className="game-interaction-card waiting" aria-live="polite">
        <LoaderCircle className="spin" size={20} />
        <div>
          <h2>下一幕已经发布</h2>
          <p>Pi Agent 正在保存本回合记录，完成后即可继续选择。</p>
        </div>
      </section>
    )
  }

  const choices = session.currentScene?.choices ?? []
  return (
    <section className="game-interaction-card">
      <div className="game-interaction-heading">
        <div><Bot size={17} /><span>你准备怎么做？</span></div>
        <small>第 {session.currentScene?.turn ?? 1} 幕</small>
      </div>
      <div className="game-choice-grid">
        {choices.map((choice) => (
          <button key={choice.id} onClick={() => onChoose(choice)}>
            <strong>{choice.text}</strong>
          </button>
        ))}
      </div>
      <form onSubmit={submit}>
        <label htmlFor="player-action">或者自由行动</label>
        <textarea
          id="player-action"
          value={text}
          maxLength={500}
          placeholder="例如：我没有立刻回答，而是先观察她袖口沾着的香灰……"
          onChange={(event) => setText(event.target.value)}
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
