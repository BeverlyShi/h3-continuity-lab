import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { zaiProvider } from '@earendil-works/pi-ai/providers/zai'

export const BIGMODEL_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

export const bigmodelProvider = () => {
  const zai = zaiProvider()
  const model = zai.getModels().find((entry) => entry.id === 'glm-5.3-flash')
  if (!model) throw new Error('Pi 未找到 GLM-5.3-Flash 模型配置。')
  return createProvider({
    id: 'bigmodel',
    name: '智谱 BigModel',
    baseUrl: BIGMODEL_BASE_URL,
    auth: zai.auth,
    models: [{
      ...model,
      provider: 'bigmodel',
      baseUrl: BIGMODEL_BASE_URL,
      // SDK 的费用字段采用美元；国内接口仅记录 token，费用以人民币账单为准。
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { ...model.compat, requiresReasoningContentOnAssistantMessages: true },
    }],
    api: openAICompletionsApi(),
  })
}
