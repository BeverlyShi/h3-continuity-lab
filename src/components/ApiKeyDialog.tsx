import { KeyRound, LockKeyhole, X } from 'lucide-react'
import { FormEvent, useState } from 'react'

type ApiKeyDialogProps = {
  savedFalApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  onClose: () => void
  onSave: (falApiKey: string, openRouterApiKey: string, deepSeekApiKey: string) => void
  onClear: () => void
}

export function ApiKeyDialog({
  savedFalApiKey,
  savedOpenRouterApiKey,
  savedDeepSeekApiKey,
  onClose,
  onSave,
  onClear,
}: ApiKeyDialogProps) {
  const [falApiKey, setFalApiKey] = useState(savedFalApiKey)
  const [openRouterApiKey, setOpenRouterApiKey] = useState(savedOpenRouterApiKey)
  const [deepSeekApiKey, setDeepSeekApiKey] = useState(savedDeepSeekApiKey)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(falApiKey.trim(), openRouterApiKey.trim(), deepSeekApiKey.trim())
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon"><KeyRound size={18} /></div>
          <div><h2 id="api-title">API 连接设置</h2><p>fal 用于视频生成，OpenRouter/DeepSeek 用于导演，DeepSeek 还负责尾帧识别</p></div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="fal-api-key">FAL_KEY</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="fal-api-key"
              type="password"
              value={falApiKey}
              onChange={(event) => setFalApiKey(event.target.value)}
              placeholder="粘贴你的 FAL_KEY"
              autoComplete="off"
              autoFocus
            />
          </div>
          <label htmlFor="openrouter-api-key">OPENROUTER_API_KEY</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="openrouter-api-key"
              type="password"
              value={openRouterApiKey}
              onChange={(event) => setOpenRouterApiKey(event.target.value)}
              placeholder="粘贴你的 OpenRouter API Key"
              autoComplete="off"
            />
          </div>
          <label htmlFor="deepseek-api-key">DEEPSEEK_API_KEY</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="deepseek-api-key"
              type="password"
              value={deepSeekApiKey}
              onChange={(event) => setDeepSeekApiKey(event.target.value)}
              placeholder="粘贴你的 DeepSeek API Key"
              autoComplete="off"
            />
          </div>
          <div className="security-note">实验版会把 Key 明文保存在浏览器 localStorage；DeepSeek Vision 只在尾帧识别时调用。共享设备上请及时清除，正式产品应改为服务端密钥。</div>
          <div className="dialog-actions">
            {(savedFalApiKey || savedOpenRouterApiKey || savedDeepSeekApiKey) && <button className="button button-danger" type="button" onClick={onClear}>清除 Keys</button>}
            <button className="button button-ghost" type="button" onClick={onClose}>取消</button>
            <button className="button button-primary" type="submit" disabled={!falApiKey.trim() && !openRouterApiKey.trim() && !deepSeekApiKey.trim()}>保存设置</button>
          </div>
        </form>
      </div>
    </div>
  )
}
