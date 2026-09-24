import Foundation
@main struct Check {
 static func main() throws {
  precondition(VideoTranscriber.isVideoID("jNQXAC9IVRw"))
  for bad in ["jNQXAC9IVR", "jNQXAC9IVRw1", "../etc/pwd", "jNQXAC9IVR w", "--exec=rm"] {
   precondition(!VideoTranscriber.isVideoID(bad), "accepted video id \(bad)")
  }
  precondition(VideoTranscriber.endpoint("http://localhost:12017")?.absoluteString == "http://localhost:12017/v1/audio/transcriptions")
  precondition(VideoTranscriber.endpoint("http://10.0.0.2:12017/")?.absoluteString == "http://10.0.0.2:12017/v1/audio/transcriptions")
  for bad in ["file:///etc/passwd", "ftp://host", "http://user:pw@host", "http://host?x=1", "not a url", "http://"] {
   precondition(VideoTranscriber.endpoint(bad) == nil, "accepted endpoint \(bad)")
  }
  precondition(VideoTranscriber.isLanguage("en") && VideoTranscriber.isLanguage("yue"))
  precondition(!VideoTranscriber.isLanguage("en\"\r\nX") && !VideoTranscriber.isLanguage("EN"))

  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }
  let audio = dir.appendingPathComponent("audio.m4a")
  try Data([0, 1, 2, 3]).write(to: audio)
  let body = dir.appendingPathComponent("body")
  try VideoTranscriber.writeMultipart(audio: audio, to: body, boundary: "B", language: "en")
  let text = String(decoding: try Data(contentsOf: body), as: UTF8.self)
  precondition(text.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json\r\n"))
  precondition(text.contains("name=\"language\"\r\n\r\nen\r\n"))
  precondition(text.contains("filename=\"audio.m4a\""))
  precondition(text.hasSuffix("\r\n--B--\r\n"))

  let parsed = VideoTranscriber.segments(from: Data(#"{"text":"hi","segments":[{"start":0.5,"end":2,"text":"hi"},{"bad":1}]}"#.utf8))
  let segments = parsed["segments"] as! [[String: Any]]
  precondition(segments.count == 1 && segments[0]["start"] as? Double == 0.5 && segments[0]["text"] as? String == "hi")
  precondition(VideoTranscriber.segments(from: Data(#"{"text":"no timing"}"#.utf8))["error"] != nil)
  print("Native transcriber validation, multipart and parsing checks passed")
 }
}
