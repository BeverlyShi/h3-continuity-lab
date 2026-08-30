import { BookOpen, Bot, ScrollText, UserRound, UsersRound } from 'lucide-react'
import { unregisteredCity } from '../../stories/unregisteredCity'
import type { GameSession } from '../../types/game'

type GameStatePanelProps = {
  session: GameSession | null
  agentReady: boolean
}

const STAT_META = [
  ['innOrder', '驿站秩序'],
  ['officialSuspicion', '官方怀疑'],
  ['guestTrust', '住客信任'],
] as const

export function GameStatePanel({ session, agentReady }: GameStatePanelProps) {
  return (
    <div className="game-state-panel">
      <section className="game-panel-card">
        <div className="game-panel-heading"><BookOpen size={15} /><h2>三张宿籍</h2></div>
        <div className="permit-list">
          {(session?.permits ?? []).map((permit) => {
            const holder = unregisteredCity.characters.find((item) => item.id === permit.holderId)
            return (
              <div className="permit-item" key={permit.id}>
                <div><strong>{permit.label}</strong><span>{permit.transferred ? '已流转' : '本夜可流转一次'}</span></div>
                <b>{holder?.name ?? '尚未分配'}</b>
              </div>
            )
          })}
          {!session && <p className="panel-empty">开始游戏后显示宿籍状态</p>}
        </div>
      </section>

      <section className="game-panel-card">
        <div className="game-panel-heading"><UserRound size={15} /><h2>驿站状态</h2></div>
        <div className="game-stat-list">
          {STAT_META.map(([key, label]) => (
            <div className="game-stat" key={key}>
              <div><span>{label}</span><strong>{session?.stats[key] ?? '—'}</strong></div>
              <progress max="100" value={session?.stats[key] ?? 0} />
            </div>
          ))}
        </div>
      </section>

      <section className="game-panel-card">
        <div className="game-panel-heading"><UsersRound size={15} /><h2>今夜来客</h2></div>
        <div className="arrival-list">
          {unregisteredCity.characters.map((character) => (
            <div key={character.id}>
              <strong>{character.name}</strong>
              <span>{character.publicIdentity}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="game-panel-card">
        <details className="game-rule-summary">
          <summary><ScrollText size={15} />不可变规则</summary>
          <ol>{unregisteredCity.coreRules.map((rule) => <li key={rule}>{rule}</li>)}</ol>
        </details>
      </section>

      <section className="game-panel-card">
        <div className="game-panel-heading"><Bot size={15} /><h2>导演连接</h2></div>
        <div className="director-connection">
          <span className={`status-dot ${agentReady ? '' : 'disconnected'}`} />
          <div>
            <strong>{agentReady ? 'Pi Director 已就绪' : 'DeepSeek 尚未配置'}</strong>
            <p>{agentReady ? '玩家行动会自动触发裁决、规则校验和文字发布' : '打开 API 设置即可启用自动导演'}</p>
          </div>
        </div>
      </section>
    </div>
  )
}
