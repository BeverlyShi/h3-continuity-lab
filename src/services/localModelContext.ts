type LocalModelContextBridge = {
  listTools: () => string[]
  invokeTool: (name: string, input?: unknown) => Promise<unknown>
}

export const installLocalModelContext = () => {
  if (!import.meta.env.DEV || document.modelContext) return

  const tools = new Map<string, WebMcpTool>()
  const channel = document.createElement('details')
  channel.id = 'local-model-context-bridge'
  channel.className = 'local-model-context-bridge'
  const summary = document.createElement('summary')
  summary.textContent = '本地导演桥'
  const form = document.createElement('form')
  const toolSelect = document.createElement('select')
  toolSelect.setAttribute('aria-label', '本地导演工具')
  const input = document.createElement('textarea')
  input.setAttribute('aria-label', '导演工具输入')
  input.placeholder = 'JSON 输入，空白等同于 {}'
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.textContent = '调用工具'
  const output = document.createElement('pre')
  output.setAttribute('aria-live', 'polite')
  form.append(toolSelect, input, submit, output)
  channel.append(summary, form)
  document.body.append(channel)

  const bridge: LocalModelContextBridge = {
    listTools: () => [...tools.keys()],
    invokeTool: async (name, input = {}) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`未知导演工具：${name}`)
      return tool.execute(input)
    },
  }

  document.modelContext = {
    source: 'local-dev',
    registerTool: async (tool) => {
      tools.set(tool.name, tool)
      channel.dataset.tools = JSON.stringify([...tools.keys()])
      const option = document.createElement('option')
      option.value = tool.name
      option.textContent = tool.name
      toolSelect.append(option)
    },
  }
  window.__localModelContext = bridge

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    try {
      const toolInput = input.value.trim() ? JSON.parse(input.value) : {}
      const result = await bridge.invokeTool(toolSelect.value, toolInput)
      output.textContent = JSON.stringify({ ok: true, result }, null, 2)
    } catch (error) {
      output.textContent = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : '导演工具调用失败。',
      }, null, 2)
    }
  })

  new MutationObserver(async () => {
    const rawRequest = channel.dataset.request
    if (!rawRequest) return
    delete channel.dataset.request
    try {
      const request = JSON.parse(rawRequest) as { id: string; name: string; input?: unknown }
      const result = await bridge.invokeTool(request.name, request.input)
      channel.dataset.response = JSON.stringify({ id: request.id, ok: true, result })
    } catch (error) {
      channel.dataset.response = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : '导演工具调用失败。',
      })
    }
  }).observe(channel, { attributes: true, attributeFilter: ['data-request'] })
}
