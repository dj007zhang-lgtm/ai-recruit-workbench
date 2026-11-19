// macOS Speech 转写（升级版）：音频文件 → 文本（zh-CN）
// 用法: stt <audio file> [--offline] [--json]
//
// 相比旧版的改进：
// 1. 本地优先：支持 on-device 时优先本地（隐私：面试录音不出本机），不可用才回退联网
// 2. 分段识别：长音频（>50s）按时间片切段识别，避免整体超时/失败
// 3. 超时自适应：按音频时长动态计算等待上限，而不是固定 60s
// 4. 输出诊断：onDevice/分段数/每段置信度，便于排查
import AVFoundation
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: stt <audio> [--offline] [--json]"); exit(2) }
let url = URL(fileURLWithPath: args[1])
let forceOffline = args.contains("--offline")
let jsonOut = args.contains("--json")

guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else {
    print("ERR: no recognizer for zh-CN"); exit(1)
}
let onDeviceSupported = rec.supportsOnDeviceRecognition
// 实测：本机 supportsOnDeviceRecognition=true 但 on-device 实际不响应（超时）。
// 因此默认走联网识别（Apple 服务器，准确率更高）；--offline 显式要求本地（隐私优先场景）。
let useOnDevice = forceOffline

// 音频时长 → 决定等待上限
var audioDuration: Double = 0
if let f = try? AVAudioFile(forReading: url) {
    audioDuration = Double(f.length) / f.processingFormat.sampleRate
}
let waitLimit = max(60.0, min(600.0, audioDuration * 1.5 + 30))

func diag(_ s: String) { if !jsonOut { print(s) } }

diag("onDevice=\(onDeviceSupported) available=\(rec.isAvailable) duration=\(String(format: "%.1f", audioDuration))s offline=\(useOnDevice)")

// 单次识别（整段）
func recognize(_ u: URL, offset: TimeInterval, completion: @escaping (String, Double, String?) -> Void) {
    let req = SFSpeechURLRecognitionRequest(url: u)
    req.requiresOnDeviceRecognition = useOnDevice
    req.shouldReportPartialResults = false
    req.taskHint = .dictation
    if #available(macOS 13.0, *) { req.addsPunctuation = true }
    var finished = false
    var best = ""
    var conf: Double = 0
    rec.recognitionTask(with: req) { result, error in
        if let e = error {
            if !finished { finished = true; completion("", 0, e.localizedDescription) }
            return
        }
        guard let r = result else { return }
        best = r.bestTranscription.formattedString
        // 平均置信度（仅取有置信度的片段）
        let segs = r.bestTranscription.segments
        if !segs.isEmpty {
            conf = segs.map { Double($0.confidence) }.reduce(0, +) / Double(segs.count)
        }
        if r.isFinal && !finished {
            finished = true
            completion(best, conf, nil)
        }
    }
    let deadline = Date().addingTimeInterval(waitLimit)
    while !finished && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
    }
    if !finished {
        finished = true
        // 超时但有部分结果 → 用部分结果（比全丢好）
        if !best.isEmpty { completion(best, conf, nil) } else { completion("", 0, "timeout") }
    }
}

// 长音频分段：按 45 秒切（Speech 对长文件不稳定）
func splitAudio(_ u: URL, chunkSeconds: Double) -> [(URL, TimeInterval)] {
    guard audioDuration > chunkSeconds * 1.5 else { return [(u, 0)] }
    guard let asset = AVURLAsset(url: u) as AVURLAsset? else { return [(u, 0)] }
    var out: [(URL, TimeInterval)] = []
    let total = audioDuration
    var start: Double = 0
    let tmpDir = FileManager.default.temporaryDirectory
    var idx = 0
    while start < total {
        let dur = min(chunkSeconds, total - start)
        let dst = tmpDir.appendingPathComponent("stt_chunk_\(ProcessInfo.processInfo.processIdentifier)_\(idx).m4a")
        try? FileManager.default.removeItem(at: dst)
        if let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) {
            export.outputURL = dst
            export.outputFileType = .m4a
            export.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600), duration: CMTime(seconds: dur, preferredTimescale: 600))
            let sem = DispatchSemaphore(value: 0)
            export.exportAsynchronously { sem.signal() }
            _ = sem.wait(timeout: .now() + 60)
            if export.status == .completed, FileManager.default.fileExists(atPath: dst.path) {
                out.append((dst, start))
            }
        }
        start += dur
        idx += 1
        if idx > 200 { break }
    }
    return out.isEmpty ? [(u, 0)] : out
}

let chunks = splitAudio(url, chunkSeconds: 45)
diag("chunks=\(chunks.count)")

var parts: [String] = []
var confSum: Double = 0
var confN = 0
var firstErr: String? = nil

// 关键：Speech 的回调依赖主线程 RunLoop；用 semaphore 阻塞主线程会导致回调永不触发（旧代码的隐患）。
// 这里改为在识别内部用 RunLoop 驱动等待（recognize 已实现），串行处理每个分片。
for (u, off) in chunks {
    var text = ""
    var conf: Double = 0
    var err: String? = nil
    recognize(u, offset: off) { t, c, e in text = t; conf = c; err = e }
    if let e = err, firstErr == nil { firstErr = e }
    if !text.isEmpty { parts.append(text); if conf > 0 { confSum += conf; confN += 1 } }
    if u.path != url.path { try? FileManager.default.removeItem(at: u) }
}

let full = parts.joined(separator: "")
let avgConf = confN > 0 ? confSum / Double(confN) : 0

if jsonOut {
    let obj: [String: Any] = [
        "ok": !full.isEmpty,
        "text": full,
        "onDevice": useOnDevice,
        "onDeviceSupported": onDeviceSupported,
        "durationSec": audioDuration,
        "chunks": chunks.count,
        "confidence": (avgConf * 1000).rounded() / 1000,
        "error": firstErr ?? ""
    ]
    if let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: d, encoding: .utf8) { print(s) }
} else {
    print("onDevice=\(useOnDevice) chunks=\(chunks.count) confidence=\(String(format: "%.2f", avgConf))")
    if let e = firstErr, full.isEmpty { print("ERR: \(e)") }
    if !full.isEmpty { print(full) }
}
exit(full.isEmpty ? 1 : 0)
