type WebMcpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, boolean>
  execute: (input: unknown) => unknown | Promise<unknown>
}

interface Document {
  modelContext?: {
    source?: 'local-dev'
    registerTool: (tool: WebMcpTool) => Promise<void>
  }
}

interface Window {
  __localModelContext?: {
    listTools: () => string[]
    invokeTool: (name: string, input?: unknown) => Promise<unknown>
  }
}
