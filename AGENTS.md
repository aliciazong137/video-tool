# AGENTS.md

## 项目概述

视频参数检查网页工具。面向 Mac / Windows 客户，通过浏览器上传视频后在本地完成参数检查与转码，不将视频上传服务器。

## 技术栈

- 框架：React + Vite
- 转码：@ffmpeg/ffmpeg + @ffmpeg/util（浏览器 WebAssembly 本地转码）
- 部署：快手 frontend-cloud 静态托管
- npm 源：https://npm.corp.kuaishou.com/

## 注意事项

- 视频文件在浏览器本地处理，不走后端上传。
- 浏览器原生 Video API 无法可靠读取编码、色深、HDR 细节；页面会明确提示这些项受浏览器限制，转码输出统一为 H.264 / SDR / 8-bit。
- 转码引擎首次加载会从 unpkg 拉取 ffmpeg core；如内网环境无法访问公网 CDN，需要改为自托管 ffmpeg-core.js / wasm 到项目 public 目录。
- 当前线上地址：https://videoqa-tool.frontend-cloud.corp.kuaishou.com
