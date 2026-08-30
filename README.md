# H3 Continuity Lab

一个用于验证连续视频生成体验的 React 前端原型，通过 fal H3 Max API 生成视频。

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

- 在左侧创建、切换项目；每个项目拥有独立的 Prompt 与视频时间轴。
- 输入首个 Prompt 后，时间轴立即加入“生成中”片段，fal 完成后自动播放。
- 后续 Prompt 会依次加入时间轴，完成后成为可播放片段。
- 当前片段结束时，如果下一段已就绪则自动续播；否则停留等待，并在下一段就绪时自动继续。
- 用户主动暂停不会被生成完成事件打断。
- 点击已完成的时间轴片段可以回看，右侧当前 Prompt 会同步切换。
- 单个片段可下载；项目可通过浏览器内 FFmpeg 按时间轴顺序合并为一个 MP4。
- 项目元数据、片段地址和 fal API Key 会保存在当前浏览器的 `localStorage` 中。

## API 接入边界

当前版本为纯前端 MVP，`FAL_KEY` 会以明文形式保存在当前设备的浏览器存储中。正式产品应将 Key 保存在服务端环境变量中，由网页请求自己的 API Route，再由服务端调用 fal。

项目视频仍引用 fal 返回的远程地址，远程资源过期后无法恢复。项目合并依赖浏览器内存和 FFmpeg WebAssembly，长视频或大量片段可能受到设备内存、跨域策略及浏览器下载策略限制。
