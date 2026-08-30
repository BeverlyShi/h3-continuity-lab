# H3 Continuity Lab

一个用于验证连续视频生成体验的 React 前端原型。首版使用公开视频作为 mock 结果，不会调用真实 API。

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm run dev
```

浏览器打开 Vite 输出的本地地址（通常为 `http://localhost:5173`）。

## 验证

```bash
npm run lint
npm run build
```

## 当前交互

- 输入首个 Prompt 后，时间轴立即加入“生成中”片段，mock 完成后自动播放。
- 后续 Prompt 会依次加入时间轴，完成后成为可播放片段。
- 当前片段结束时，如果下一段已就绪则自动续播；否则停留等待，并在下一段就绪时自动继续。
- 用户主动暂停不会被生成完成事件打断。
- 点击已完成的时间轴片段可以回看，右侧当前 Prompt 会同步切换。
- 顶部可录入 fal API Key；原型只在内存中暂存，不会持久化或发起网络请求。

## API 接入边界

正式接入时应将真实 `FAL_KEY` 保存在服务端环境变量中，由网页请求自己的 API Route，再由服务端调用 fal。不要把生产 Key 打包进浏览器代码。`src/types/video.ts` 定义了生成器边界，`src/services/mockVideoGenerator.ts` 是后续替换为 fal queue submit/status/result 的适配位置，播放队列逻辑位于 `src/hooks/useVideoQueue.ts`。
