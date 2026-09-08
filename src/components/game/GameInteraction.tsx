import { FormEvent, useState } from 'react'
import { Bot, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import { isDirectorActive } from '../../services/directorStatus'
import { ALLOW_CHOICE_BEFORE_MEDIA } from '../../config/debugFlags'
import type { DirectorStatus } from '../../types/director'
import type { GameSession } from '../../types/game'
import type { StoryChoice } from '../../types/story'

type GameInteractionProps = {
  session: GameSession
  directorStatus: DirectorStatus
  mediaBusy?: boolean
  onChoose: (choice: StoryChoice) => boolean
  onSubmitFreeform: (text: string) => boolean
  onRetry: () => void
}

export function GameInteraction({
  session,
  directorStatus,
  mediaBusy,
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
          <p>模型会发布下一幕，并按模板编写视频 Prompt。</p>
        </div>
      </section>
    )
  }

  // 场景一发布就展示三个选项；视频与尾帧识别完成前只读，不能提交。
  const mediaPending = session.status === 'awaiting_media' || Boolean(mediaBusy)
  const lockedReason = mediaPending && !ALLOW_CHOICE_BEFORE_MEDIA
    ? (session.currentScene?.videoMode === 'manual'
        ? '请逐段上传视频；最后一段完成尾帧识别后即可选择。'
        : '视频生成并完成尾帧识别后即可选择。')
    : isDirectorActive(directorStatus)
      ? 'Pi Agent 正在保存本回合记录，完成后即可选择。'
      : ''
  const locked = Boolean(lockedReason)

  const choices = session.currentScene?.choices ?? []
  return (
    <section className="game-interaction-card">
      <div className="game-interaction-heading">
        <div><Bot size={17} /><span>你准备怎么做？</span></div>
        <small>第 {session.currentScene?.turn ?? 1} 幕</small>
      </div>
      <div className={`game-choice-grid${locked ? ' locked' : ''}`} aria-disabled={locked}>
        {choices.map((choice) => (
          <button key={choice.id} disabled={locked} onClick={() => onChoose(choice)}>
            <strong>{choice.text}</strong>
          </button>
        ))}
      </div>
      {locked && (
        <p className="game-choice-locked" aria-live="polite">
          <LoaderCircle className="spin" size={13} />{lockedReason}
        </p>
      )}
      {!locked && mediaPending && (
        <p className="game-choice-locked">调试模式：视频尚未完成也可以选择，下一幕将没有尾帧状态。</p>
      )}
      <form onSubmit={submit}>
        <label htmlFor="player-action">或者自由行动</label>
        <textarea
          id="player-action"
          value={text}
          maxLength={500}
          disabled={locked}
          placeholder="例如：我没有立刻回答，而是先观察她袖口沾着的香灰……"
          onChange={(event) => setText(event.target.value)}
        />
        <div className="game-action-footer">
          <span>{text.length} / 500</span>
          <button className="button button-primary" disabled={locked || !text.trim()} type="submit">
            <Send size={15} />提交行动
          </button>
        </div>
      </form>
    </section>
  )
}
