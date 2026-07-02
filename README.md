# 视频参数检查工具

浏览器版视频参数检查与转码工具，适合客户在 Mac / Windows 上直接打开网页使用。

## 功能

- 上传/拖入视频文件
- 检查分辨率、文件大小、帧率、码率
- 标记是否符合：1080×1920 或 720×1280、≤120fps、3000-5000kbps、3GB 内
- 浏览器本地一键转码为 MP4 / H.264 / 保持源帧率 / SDR 8-bit
- 输出文件名默认为：原文件名_转码.mp4

## 本地开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 部署

推送 main 分支即可触发 Vercel 自动部署。

线上地址：

- https://video-tool-theta-two.vercel.app/

## 注意

浏览器无法像 ffprobe 一样完整读取视频编码、色深、HDR 元数据，因此编码和色彩项会提示“浏览器限制”。如果点击转码，输出会统一为 H.264 / SDR / 8-bit。
