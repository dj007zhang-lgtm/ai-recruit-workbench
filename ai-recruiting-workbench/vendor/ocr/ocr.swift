// macOS Vision OCR：图片或 PDF → 文本（zh-Hans + en）
// 用法: ocr <image|pdf> [maxPages]
// PDF 通过 PDFKit 逐页渲染成位图再识别（扫描件简历的主场景）
import Foundation
import Vision
import AppKit
import PDFKit

func recognize(_ cg: CGImage) {
    let req = VNRecognizeTextRequest { r, _ in
        guard let obs = r.results as? [VNRecognizedTextObservation] else { return }
        for o in obs { if let t = o.topCandidates(1).first { print(t.string) } }
    }
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    do { try handler.perform([req]) } catch { fputs("ERR: \(error.localizedDescription)\n", stderr) }
}

let args = CommandLine.arguments
guard args.count >= 2 else { print("usage: ocr <image|pdf> [maxPages]"); exit(2) }
let path = args[1]
let maxPages = args.count >= 3 ? (Int(args[2]) ?? 10) : 10
let url = URL(fileURLWithPath: path)

if url.pathExtension.lowercased() == "pdf" {
    guard let doc = PDFDocument(url: url) else { print("ERR: cannot open pdf"); exit(2) }
    let n = min(doc.pageCount, maxPages)
    for i in 0..<n {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0
        let w = max(1, Int(bounds.width * scale)), h = max(1, Int(bounds.height * scale))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue) else { continue }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        if let cg = ctx.makeImage() { recognize(cg) }
        if i < n - 1 { print("") }
    }
    exit(0)
}

guard let img = NSImage(contentsOfFile: path), let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff), let cg = rep.cgImage else { print("ERR: cannot load image"); exit(2) }
recognize(cg)
