// macOS Speech 转写：音频文件 → 文本（zh-CN 优先）
// 用法: stt <audio file>  （aiff/m4a/wav/caf）
import Foundation
import Speech

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: stt <audio>"); exit(2) }
let url = URL(fileURLWithPath: args[1])
guard let rec = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")) else { print("ERR: no recognizer"); exit(1) }
print("onDevice=\(rec.supportsOnDeviceRecognition) available=\(rec.isAvailable)")
let req = SFSpeechURLRecognitionRequest(url: url)
req.requiresOnDeviceRecognition = false
req.shouldReportPartialResults = false
var done = false
rec.recognitionTask(with: req) { result, error in
    if let e = error { print("ERR: \(e.localizedDescription)"); done = true; exit(1) }
    if let r = result, r.isFinal {
        print(r.bestTranscription.formattedString)
        done = true
        exit(0)
    }
}
// 等最多 60s
let deadline = Date().addingTimeInterval(60)
while !done && Date() < deadline { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2)) }
if !done { print("ERR: timeout"); exit(3) }
