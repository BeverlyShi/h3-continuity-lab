import { FormEvent, useState } from 'react'
import { Bot, Film, LoaderCircle, RotateCcw, Send } from 'lucide-react'
import { isDirectorActive } from '../../services/directorStatus'
import type { DirectorStatus } from '../../types/director'
import type { GameScene, GameSession } from '../../types/game'
import type { StoryChoice } from '../../types/story'

type GameInteractionProps = {
  session: GameSession
  directorStatus: DirectorStatus
  videoMode: NonNullable<GameScene['videoMode']>
  comfyAutoGenerate: boolean
  mediaRunning: boolean
  onChoose: (choice: StoryChoice) => boolean
  onSubmitFreeform: (text: string) => boolean
  onRetry: () => void
  onSkipVideo: () => void
}

const videoHint = (videoMode: NonNullable<GameScene['videoMode']>, comfyAutoGenerate: boolean, mediaRunning: boolean) => {
  if (videoMode === 'comfy' && !comfyAutoGenerate) return mediaRunning ? 'Comfy 正在生成，完成一段后需要再点击继续。' : '点时间轴上的「生成本场次视频」开始，按秒消耗 Comfy 积分。'
  return mediaRunning ? '正在自动逐段生成。' : '自动生成已停止，可以在时间轴上重试这一段。'
}

export function GameInteraction({
  session,
  directorStatus,
  videoMode,
  comfyAutoGenerate,
  mediaRunning,
  onChoose,
  onSubmitFreeform,
  onRetry,
  onSkipVideo,
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
            <h2>上次写作已中断</h2>
            <p>玩家输入仍已保存，可以让导演重写本场次。</p>
          </div>
          <button className="button button-secondary" onClick={onRetry}>重试本场次</button>
        </section>
      )
    }
    return (
      <section className="game-interaction-card waiting" aria-live="polite">
        <LoaderCircle className="spin" size={20} />
        <div>
          <h2>导演正在写本场次</h2>
          <p>导演会一次写好剧情、选角和整场分镜。</p>
        </div>
      </section>
    )
  }

  if (session.status === 'awaiting_video') {
    return (
      <section className="game-interaction-card waiting video" aria-live="polite">
        {mediaRunning ? <LoaderCircle className="spin" size={20} /> : <Film size={20} />}
        <div>
          <h2>本场次视频完成后开放选择</h2>
          <p>{videoHint(videoMode, comfyAutoGenerate, mediaRunning)}</p>
        </div>
        <button className="button button-secondary" disabled={isDirectorActive(directorStatus)} onClick={onSkipVideo}>跳过视频，直接选择</button>
      </section>
    )
  }

  const choices = session.currentScene?.choices ?? []
  return (
    <section className="game-interaction-card">
      <div className="game-interaction-heading">
        <div><Bot size={17} /><span>你准备怎么做？</span></div>
        <small>第 {session.currentScene?.turn ?? 1} 场次</small>
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
