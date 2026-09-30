import Foundation
import CoreImage
for path in CommandLine.arguments.dropFirst() {
  let img = CIImage(contentsOf: URL(fileURLWithPath: path))!
  let d = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
  let got = (d.features(in: img).first as? CIQRCodeFeature)?.messageString ?? "(읽지 못함)"
  let want = try! String(contentsOfFile: path + ".txt", encoding: .utf8)
  print(got == want ? "OK" : "MISMATCH got=\(got)", path)
}
