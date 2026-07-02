import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import MediaInfoFactory from 'mediainfo.js'
import './styles.css'

const TARGET = {
  width: 1080,
  height: 1920,
  altWidth: 720,
  altHeight: 1280,
  fps: 30,
  bitrateMin: 3000,
  bitrateMax: 5000,
  sizeMaxGB: 3,
}

const fmtSize = (bytes) => {
  const mb = bytes / 1024 / 1024
  const gb = mb / 1024
  return gb >= 1 ? `${gb.toFixed(2)}GB` : `${mb.toFixed(0)}MB`
}

const fmtDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return '未知'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

const safeNumber = (value, fallback = 0) => Number.isFinite(value) ? value : fallback

function inspectVideo(file) {
  const mediaInfoPromise = readMediaInfo(file).catch((e) => {
    console.warn('MediaInfo 读取失败，降级使用浏览器信息', e)
    return null
  })
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.src = url

    video.onloadedmetadata = async () => {
      try {
        const width = video.videoWidth
        const height = video.videoHeight
        const duration = safeNumber(video.duration)
        const bitrateKbps = duration > 0 ? Math.round((file.size * 8) / duration / 1000) : 0

        let fps = 0
        try {
          if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
            let frames = 0
            video.currentTime = Math.min(1, duration / 3 || 0)
            await video.play().catch(() => {})
            const start = performance.now()
            await new Promise((done) => {
              const tick = () => {
                frames += 1
                if (performance.now() - start > 900 || frames >= 90) done()
                else video.requestVideoFrameCallback(tick)
              }
              video.requestVideoFrameCallback(tick)
            })
            video.pause()
            fps = Math.round(frames / ((performance.now() - start) / 1000))
            if (fps > 35 && fps < 55) fps = 30
            if (fps > 55 && fps < 75) fps = 60
          }
        } catch (_) {}

        if (!fps) fps = 30

        URL.revokeObjectURL(url)
        const media = await mediaInfoPromise
        const videoTrack = media?.media?.track?.find(t => t['@type'] === 'Video') || {}
        const codec = videoTrack.Format || videoTrack.CodecID || '未知'
        const bitDepth = videoTrack.BitDepth ? `${videoTrack.BitDepth}-bit` : '未知'
        const transfer = videoTrack.transfer_characteristics || videoTrack.TransferCharacteristics || ''
        const primaries = videoTrack.colour_primaries || videoTrack.ColorPrimaries || ''
        const colorSpace = videoTrack.color_space || videoTrack.ColorSpace || ''
        const hdrHint = `${transfer} ${primaries} ${colorSpace}`.toLowerCase()
        const isHdr = /smpte|pq|hlg|bt\.2020|bt2020|hdr/.test(hdrHint)
        const color = isHdr ? `HDR / ${bitDepth}` : `SDR / ${bitDepth}`
        const exactFps = videoTrack.FrameRate ? Math.round(parseFloat(videoTrack.FrameRate)) : fps
        const exactBitrate = videoTrack.BitRate ? Math.round(parseInt(videoTrack.BitRate, 10) / 1000) : bitrateKbps

        resolve({
          width: Number(videoTrack.Width) || width,
          height: Number(videoTrack.Height) || height,
          duration,
          bitrateKbps: exactBitrate,
          fps: exactFps,
          size: file.size,
          sizeGB: file.size / 1024 / 1024 / 1024,
          codec,
          bitDepth,
          color,
          isHdr,
        })
      } catch (e) {
        URL.revokeObjectURL(url)
        reject(e)
      }
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取视频，请确认文件格式是否支持'))
    }
  })
}

async function readMediaInfo(file) {
  const mediaInfo = await MediaInfoFactory({
    locateFile: () => '/mediainfo/MediaInfoModule.wasm',
    format: 'object',
  })
  try {
    const getSize = () => file.size
    const readChunk = async (chunkSize, offset) =>
      new Uint8Array(await file.slice(offset, offset + chunkSize).arrayBuffer())
    return await mediaInfo.analyzeData(getSize, readChunk)
  } finally {
    mediaInfo.close?.()
  }
}

function buildChecks(info) {
  const checks = []
  let needFix = false
  const pass = (name, value, note = '通过') => checks.push({ name, value, status: 'pass', note })
  const warn = (name, value, note) => checks.push({ name, value, status: 'warn', note })
  const fail = (name, value, note) => { checks.push({ name, value, status: 'fail', note }); needFix = true }

  const isTargetRes = (info.width === TARGET.width && info.height === TARGET.height) || (info.width === TARGET.altWidth && info.height === TARGET.altHeight)
  if (isTargetRes) pass('分辨率', `${info.width}×${info.height}`)
  else if (info.width > TARGET.width || info.height > TARGET.height) fail('分辨率', `${info.width}×${info.height}`, '超出上限')
  else warn('分辨率', `${info.width}×${info.height}`, '不在建议范围')

  if (info.sizeGB < TARGET.sizeMaxGB) pass('文件大小', fmtSize(info.size))
  else fail('文件大小', fmtSize(info.size), '超出 3GB')

  if (info.fps === TARGET.fps) pass('帧率', `${info.fps}fps`)
  else if (info.fps >= 24 && info.fps <= 60) warn('帧率', `${info.fps}fps`, '建议 30fps')
  else fail('帧率', `${info.fps}fps`, '差距较大')

  if (info.bitrateKbps >= TARGET.bitrateMin && info.bitrateKbps <= TARGET.bitrateMax) pass('码率', `${info.bitrateKbps}kbps`)
  else if (info.bitrateKbps < TARGET.bitrateMin) warn('码率', `${info.bitrateKbps}kbps`, '偏低')
  else fail('码率', `${info.bitrateKbps}kbps`, '超出 5000kbps')

  const codecText = String(info.codec || '').toLowerCase()
  if (/avc|h\.264|h264/.test(codecText)) pass('编码', info.codec, 'H.264')
  else if (/hevc|h\.265|h265/.test(codecText)) warn('编码', info.codec, 'HEVC，可转 H.264')
  else warn('编码', info.codec, '建议 H.264')

  if (info.isHdr) fail('色彩', info.color, '要求 SDR')
  else if (info.bitDepth && info.bitDepth !== '8-bit') warn('色彩', info.color, '建议 8-bit')
  else pass('色彩', info.color, 'SDR 8-bit')

  return { checks, needFix }
}

function App() {
  const [file, setFile] = useState(null)
  const [info, setInfo] = useState(null)
  const [checks, setChecks] = useState([])
  const [needFix, setNeedFix] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('把视频拖进来，浏览器本地完成检查。')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [downloadName, setDownloadName] = useState('')
  const [logs, setLogs] = useState([])
  const ffmpegRef = useRef(null)
  // ref 持有最新的 info，让 ffmpeg log 回调能拿到当前视频时长（避免闭包捕获旧值）
  const infoRef = useRef(null)
  // log 节流：ffmpeg 高频输出，避免 setState 过多卡 UI
  const lastLogFlushRef = useRef(0)
  const pendingLogsRef = useRef([])

  // 同步 info 到 ref，让 ffmpeg log 回调能拿到最新视频时长
  useEffect(() => { infoRef.current = info }, [info])

  const verdict = useMemo(() => {
    if (!info) return null
    return needFix ? '有参数不合规，建议一键转码' : '参数符合要求，可以直接上传'
  }, [info, needFix])

  async function handleFile(nextFile) {
    if (!nextFile) return
    setFile(nextFile)
    setInfo(null)
    setChecks([])
    setDownloadUrl('')
    setProgress(0)
    setStatus('正在读取视频参数…')
    try {
      const nextInfo = await inspectVideo(nextFile)
      const result = buildChecks(nextInfo)
      setInfo(nextInfo)
      setChecks(result.checks)
      setNeedFix(result.needFix)
      setStatus('检查完成')
    } catch (e) {
      setStatus(e.message || '读取失败')
    }
  }

  async function ensureFFmpeg() {
    if (ffmpegRef.current) return ffmpegRef.current
    const ffmpeg = new FFmpeg()
    ffmpeg.on('progress', ({ progress }) => {
      const pct = Math.min(99, Math.max(0, Math.round(progress * 100)))
      setProgress(pct)
      setStatus(`转码中 ${pct}%`)
    })
    ffmpeg.on('log', ({ type, message }) => {
      const line = message.trim()
      if (!line) return
      // 透传到 console，方便 DevTools 直接看 ffmpeg 原始输出
      console.log('[ffmpeg]', line)
      // 解析 time=HH:MM:SS.xx 算真实进度（比 progress 事件准）
      const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m) {
        const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])
        const dur = infoRef.current?.duration
        if (dur && dur > 0) {
          const pct = Math.min(99, Math.max(0, Math.round(sec / dur * 100)))
          setProgress(pct)
          setStatus(`转码中 ${pct}% · ${line}`)
        }
      }
      // 节流累积日志到 logs state，最多 200ms flush 一次
      pendingLogsRef.current.push(line)
      const now = Date.now()
      if (now - lastLogFlushRef.current > 200) {
        lastLogFlushRef.current = now
        const recent = pendingLogsRef.current.slice(-8)
        pendingLogsRef.current = recent
        setLogs(recent)
      }
    })
    setStatus('首次加载转码引擎，稍等片刻…')
    await ffmpeg.load({
      coreURL: '/ffmpeg-core/ffmpeg-core.js',
      wasmURL: '/ffmpeg-core/ffmpeg-core.wasm',
    })
    ffmpegRef.current = ffmpeg
    return ffmpeg
  }

  async function transcode() {
    if (!file || !info) return
    setBusy(true)
    setProgress(0)
    setStatus('准备转码…')
    setLogs([])
    pendingLogsRef.current = []
    try {
      const ffmpeg = await ensureFFmpeg()
      const inputName = `input.${(file.name.split('.').pop() || 'mp4').toLowerCase()}`
      const outputName = `${file.name.replace(/\.[^.]+$/, '')}_转码.mp4`
      setStatus('正在读取视频到引擎…')
      await ffmpeg.writeFile(inputName, await fetchFile(file))

      const args = [
        '-i', inputName,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-b:v', '4500k',
        '-maxrate', '5000k',
        '-bufsize', '9000k',
        '-r', '30',
        '-pix_fmt', 'yuv420p',
        '-color_range', 'tv',
        '-color_trc', 'bt709',
        '-color_primaries', 'bt709',
        '-colorspace', 'bt709',
        '-vf', `scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=decrease,pad=${TARGET.width}:${TARGET.height}:(ow-iw)/2:(oh-ih)/2:black`,
        '-c:a', 'aac',
        '-b:a', '128k',
        outputName,
      ]
      await ffmpeg.exec(args)
      // flush 剩余未展示的日志
      if (pendingLogsRef.current.length > 0) {
        setLogs(pendingLogsRef.current.slice(-8))
      }
      const data = await ffmpeg.readFile(outputName)
      const blob = new Blob([data.buffer], { type: 'video/mp4' })
      const url = URL.createObjectURL(blob)
      setDownloadUrl(url)
      setDownloadName(outputName)
      setProgress(100)
      setStatus('转码完成，可以下载。')
    } catch (e) {
      console.error(e)
      setStatus(`转码失败：${e.message || e}`)
    } finally {
      setBusy(false)
    }
  }

  return <main className="page">
    <section className="hero">
      <div className="badge">LOCAL VIDEO QA · SDR 9:16</div>
      <h1>视频参数检查工具</h1>
      <p>客户只需要浏览器。视频在本地解析和转码，不上传服务器；像暗房里的质检台，安静、准确、不乱碰素材。</p>
    </section>

    <section
      className="dropzone"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files?.[0]) }}
    >
      <input id="file" type="file" accept="video/*" onChange={(e) => handleFile(e.target.files?.[0])} />
      <label htmlFor="file">
        <span className="plus">+</span>
        <strong>{file ? file.name : '选择或拖入视频文件'}</strong>
        <em>目标：1080×1920 / 720×1280，30fps，3000-5000kbps，MP4，SDR</em>
      </label>
    </section>

    <section className="panel">
      <div className="status-row">
        <div>
          <span className="label">当前状态</span>
          <strong>{status}</strong>
        </div>
        <div className="meter"><i style={{ width: `${progress}%` }} /></div>
      </div>

      {logs.length > 0 && <pre className="ffmpeg-log">{logs.join('\n')}</pre>}

      {info && <div className="summary">
        <div><span>时长</span><b>{fmtDuration(info.duration)}</b></div>
        <div><span>大小</span><b>{fmtSize(info.size)}</b></div>
        <div><span>推算码率</span><b>{info.bitrateKbps}kbps</b></div>
      </div>}

      <div className="checks">
        {checks.map((c) => <div className={`check ${c.status}`} key={c.name}>
          <span>{c.name}</span>
          <b>{c.value}</b>
          <em>{c.note}</em>
        </div>)}
      </div>

      {verdict && <div className={`verdict ${needFix ? 'bad' : 'good'}`}>{verdict}</div>}

      <div className="actions">
        <button disabled={!file || busy} onClick={transcode}>一键转码为合规 MP4</button>
        {downloadUrl && <a className="download" href={downloadUrl} download={downloadName}>下载 {downloadName}</a>}
      </div>
    </section>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
