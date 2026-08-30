import {
  Activity,
  AlertCircle,
  BookOpenText,
  BrainCircuit,
  Clock3,
  Database,
  GitCompareArrows,
  ShieldCheck,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import { useState } from 'react'
import type { AgentTraceEntry, AgentTraceRun } from '../types/director'

const entryIcon: Record<AgentTraceEntry['kind'], typeof Activity> = {
  input: TerminalSquare,
  thinking: BrainCircuit,
  assistant: Activity,
  tool_call: Wrench,
  tool_result: Database,
  rule_check: ShieldCheck,
  state_diff: GitCompareArrows,
  published: BookOpenText,
  error: AlertCircle,
}

const formatClock = (timestamp: number) => new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(timestamp)

const stringify = (value: unknown) => JSON.stringify(value, null, 2)

function TraceEntry({ entry }: { entry: AgentTraceEntry }) {
  const Icon = entryIcon[entry.kind]
  const collapsedByDefault = entry.kind === 'input' || entry.kind === 'thinking'

  return (
    <li className={`trace-entry ${entry.kind} ${entry.isError ? 'is-error' : ''}`}>
      <span className="trace-entry-icon"><Icon size={14} /></span>
      <details open={!collapsedByDefault}>
        <summary>
          <div><strong>{entry.title}</strong><small>{formatClock(entry.timestamp)}</small></div>
          {collapsedByDefault && <span>{entry.kind === 'input' ? '含导演秘密' : '点击展开'}</span>}
        </summary>
        {entry.text && <p>{entry.text}</p>}
        {entry.data !== undefined && <pre>{stringify(entry.data)}</pre>}
      </details>
    </li>
  )
}

function TraceRunItem({ trace, active, onSelect }: {
  trace: AgentTraceRun
  active: boolean
  onSelect: () => void
}) {
  return (
    <button className={`trace-run-item ${active ? 'active' : ''}`} onClick={onSelect}>
      <span className={`trace-run-status ${trace.status}`} />
      <div>
        <strong>回合 {trace.turn} · {trace.action}</strong>
        <small>{formatClock(trace.startedAt)} · {trace.status === 'running' ? '运行中' : trace.status === 'error' ? '失败' : '已完成'}</small>
      </div>
    </button>
  )
}

export function TracePage({ traces }: { traces: AgentTraceRun[] }) {
  const [selectedTraceId, setSelectedTraceId] = useState('')
  const selectedTrace = traces.find((trace) => trace.id === selectedTraceId) ?? traces[0]

  return (
    <main className="trace-workspace">
      <header className="trace-header">
        <div>
          <div className="game-eyebrow"><Activity size={14} /> Agent 诊断</div>
          <h1>Trace</h1>
          <p>Pi Agent 运行轨迹、持久化 Session、规则校验与最终状态变更。</p>
        </div>
        <div className="trace-security-note"><ShieldCheck size={14} />开发视图 · 输入可能包含角色秘密</div>
      </header>

      <div className="trace-layout">
        <aside className="trace-run-list">
          <div className="trace-panel-heading"><span>运行记录</span><b>{traces.length}</b></div>
          {traces.length ? traces.map((trace) => (
            <TraceRunItem
              key={trace.id}
              trace={trace}
              active={trace.id === selectedTrace?.id}
              onSelect={() => setSelectedTraceId(trace.id)}
            />
          )) : (
            <div className="trace-run-empty"><Activity size={20} /><span>提交一次游戏行动后，这里会出现 Agent 轨迹。</span></div>
          )}
        </aside>

        <section className="trace-detail">
          {selectedTrace ? (
            <>
              <div className="trace-detail-heading">
                <div><h2>回合 {selectedTrace.turn}</h2><p>{selectedTrace.action}</p></div>
                <span className={`trace-outcome ${selectedTrace.status}`}>{selectedTrace.status === 'running' ? '运行中' : selectedTrace.status === 'error' ? '执行失败' : '执行完成'}</span>
              </div>

              <div className="trace-metrics">
                <div><Clock3 size={14} /><span>总耗时</span><strong>{selectedTrace.endedAt ? `${selectedTrace.endedAt - selectedTrace.startedAt} ms` : '—'}</strong></div>
                <div><Activity size={14} /><span>停止原因</span><strong>{selectedTrace.stopReason ?? '—'}</strong></div>
                <div><BrainCircuit size={14} /><span>推理 Tokens</span><strong>{selectedTrace.usage?.reasoning ?? '—'}</strong></div>
                <div><Database size={14} /><span>总 Tokens</span><strong>{selectedTrace.usage?.totalTokens ?? '—'}</strong></div>
              </div>

              <div className="trace-session-line">
                <span>Trace ID</span><code>{selectedTrace.id}</code>
                <span>Pi Session</span><code>{selectedTrace.harnessSessionId ?? '正在创建…'}</code>
              </div>

              <ol className="trace-timeline">
                {selectedTrace.entries.map((entry) => <TraceEntry key={entry.id} entry={entry} />)}
                {selectedTrace.status === 'running' && (
                  <li className="trace-entry trace-pending"><span className="trace-entry-icon"><Activity className="spin" size={14} /></span><div><strong>等待下一条轨迹事件</strong></div></li>
                )}
              </ol>
            </>
          ) : (
            <div className="trace-detail-empty"><BrainCircuit size={30} /><h2>暂无轨迹</h2><p>进入“游戏互动”提交行动，Trace 会记录完整的 Pi Agent 执行过程。</p></div>
          )}
        </section>
      </div>
    </main>
  )
}
