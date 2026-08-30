import { History } from 'lucide-react'
import type { GameEvent } from '../../types/game'

export function GameEventLog({ events }: { events: GameEvent[] }) {
  if (!events.length) return null
  return (
    <section className="game-event-card">
      <div className="game-panel-heading"><History size={15} /><h2>事件记录</h2></div>
      <ol>
        {events.slice(-6).reverse().map((event) => (
          <li key={event.id}><span>回合 {event.turn}</span><p>{event.text}</p></li>
        ))}
      </ol>
    </section>
  )
}
