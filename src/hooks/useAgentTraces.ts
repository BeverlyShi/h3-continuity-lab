import { useCallback, useState } from 'react'
import type { AgentTraceEntry, AgentTraceRun, AgentTraceUpdate } from '../types/director'

export function useAgentTraces() {
  const [traces, setTraces] = useState<AgentTraceRun[]>([])

  const updateTrace = useCallback((update: AgentTraceUpdate) => {
    setTraces((current) => {
      if (update.type === 'start') return [update.run, ...current]

      return current.map((trace) => {
        if (trace.id !== update.traceId) return trace

        if (update.type === 'harness') {
          return {
            ...trace,
            harnessSessionId: update.snapshot.harnessSessionId,
            outcome: update.snapshot.outcome,
            stopReason: update.snapshot.stopReason,
            usage: update.snapshot.usage,
            entries: [...update.snapshot.entries, ...trace.entries],
          }
        }
        if (update.type === 'append') {
          return { ...trace, entries: [...trace.entries, update.entry] }
        }
        if (update.type === 'complete') {
          return { ...trace, status: 'completed', endedAt: update.endedAt }
        }

        const errorEntry: AgentTraceEntry = {
          id: crypto.randomUUID(),
          kind: 'error',
          title: '执行失败',
          text: update.message,
          timestamp: update.endedAt,
          isError: true,
        }
        return {
          ...trace,
          status: 'error',
          endedAt: update.endedAt,
          entries: [...trace.entries, errorEntry],
        }
      })
    })
  }, [])

  return { traces, updateTrace }
}
