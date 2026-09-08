import { KeyRound, LockKeyhole, Trash2, X } from 'lucide-react'
import { FormEvent, useState } from 'react'
import { clearLocalMedia } from '../services/localData'

type ApiKeyDialogProps = {
  savedFalApiKey: string
  savedOpenRouterApiKey: string
  savedDeepSeekApiKey: string
  savedBigModelApiKey: string
  onClose: () => void
  onSave: (falApiKey: string, openRouterApiKey: string, deepSeekApiKey: string, bigModelApiKey: string) => void
  onClear: () => void
}

export function ApiKeyDialog({
  savedFalApiKey,
  savedOpenRouterApiKey,
  savedDeepSeekApiKey,
  savedBigModelApiKey,
  onClose,
  onSave,
  onClear,
}: ApiKeyDialogProps) {
  const [falApiKey, setFalApiKey] = useState(savedFalApiKey)
  const [openRouterApiKey, setOpenRouterApiKey] = useState(savedOpenRouterApiKey)
  const [deepSeekApiKey, setDeepSeekApiKey] = useState(savedDeepSeekApiKey)
  const [bigModelApiKey, setBigModelApiKey] = useState(savedBigModelApiKey)
  const [clearing, setClearing] = useState(false)

  const clearMedia = async () => {
    if (clearing || !window.confirm('确定清理本地视频与存档吗？此操作无法撤销。')) return
    setClearing(true)
    try {
      await clearLocalMedia()
      location.reload()
    } finally {
      setClearing(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(falApiKey.trim(), openRouterApiKey.trim(), deepSeekApiKey.trim(), bigModelApiKey.trim())
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="api-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-heading">
          <div className="dialog-icon"><KeyRound size={18} /></div>
          <div><h2 id="api-title">API 连接设置</h2><p>上传视频模式无需 fal Key；OpenRouter/DeepSeek/智谱用于导演，DeepSeek 还负责尾帧识别</p></div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="fal-api-key">FAL_KEY（仅 API 生成需要）</label>
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
          <label htmlFor="bigmodel-api-key">BIGMODEL_API_KEY（智谱官方 GLM）</label>
          <div className="input-with-icon">
            <LockKeyhole size={15} />
            <input
              id="bigmodel-api-key"
              type="password"
              value={bigModelApiKey}
              onChange={(event) => setBigModelApiKey(event.target.value)}
              placeholder="粘贴智谱 BigModel 通用 API Key"
              autoComplete="off"
            />
          </div>
          <div className="dialog-section">
            <strong>本地数据</strong>
            <p>删除游戏存档、视频项目和上传的视频；保留 API Key、模型设置和演员库。</p>
            <button className="button button-secondary" type="button" disabled={clearing} onClick={() => { void clearMedia() }}>
              <Trash2 size={15} />{clearing ? '清理中…' : '清理本地视频与存档'}
            </button>
          </div>
          <div className="security-note">实验版会把 Key 明文保存在浏览器 localStorage；DeepSeek Vision 只在尾帧识别时调用。共享设备上请及时清除，正式产品应改为服务端密钥。</div>
          <div className="dialog-actions">
            {(savedFalApiKey || savedOpenRouterApiKey || savedDeepSeekApiKey || savedBigModelApiKey) && <button className="button button-danger" type="button" onClick={onClear}>清除 Keys</button>}
            <button className="button button-ghost" type="button" onClick={onClose}>取消</button>
            <button className="button button-primary" type="submit" disabled={!falApiKey.trim() && !openRouterApiKey.trim() && !deepSeekApiKey.trim() && !bigModelApiKey.trim()}>保存设置</button>
          </div>
        </form>
      </div>
    </div>
  )
}
