import Foundation
import OSLog
import SafariServices

// Transcription diagnostics: `log stream --predicate 'subsystem == "app.readfrog.safari"'`.
let transcriptionLog = Logger(subsystem: "app.readfrog.safari", category: "transcription")

// One ephemeral network session per request: neither cookies nor account data
// are retained in an App-owned cookie jar, cache, preferences, or log.
final class AccountHTTPTransport: NSObject, URLSessionDataDelegate {
    static func isAccountURL(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == "api.readfrog.app"
            && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
            && ["/api/identity", "/api/rpc"].contains { url.path == $0 || url.path.hasPrefix($0 + "/") }
    }

    static func isSessionCookie(_ name: String) -> Bool {
        name.range(of: #"^(?:__Secure-|__Host-)?better-auth\.session_token(?:\.\d+)?$"#, options: .regularExpression) != nil
    }

    static func makeRequest(_ message: [String: Any]) throws -> URLRequest {
        guard let raw = message["url"] as? String, let url = URL(string: raw), isAccountURL(url),
              let method = message["method"] as? String,
              ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(method),
              let headers = message["headers"] as? [[String]],
              let cookies = message["cookies"] as? [[String: String]] else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 120)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        // Drop routing, cookie, browser-origin, and hop-by-hop headers supplied
        // by JS. A fixed official origin is used for the website's CSRF check.
        let allowed = Set(["accept", "content-type", "accept-language", "x-orpc-version", "last-event-id"])
        for pair in headers where pair.count == 2 && allowed.contains(pair[0].lowercased()) {
            guard !pair[1].contains("\r"), !pair[1].contains("\n") else { throw URLError(.badURL) }
            request.setValue(pair[1], forHTTPHeaderField: pair[0])
        }
        let pairs = try cookies.map { cookie -> String in
            guard let name = cookie["name"], let value = cookie["value"], isSessionCookie(name),
                  value.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e && $0 != 0x3b && $0 != 0x2c && $0 != 0x22 && $0 != 0x5c }) else {
                throw URLError(.badURL)
            }
            return name + "=" + value
        }
        if !pairs.isEmpty { request.setValue(pairs.joined(separator: "; "), forHTTPHeaderField: "Cookie") }
        request.setValue("https://www.readfrog.app", forHTTPHeaderField: "Origin")
        if let bytes = message["body"] as? [UInt8] {
            guard bytes.count <= 8 * 1024 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
            request.httpBody = Data(bytes)
        }
        return request
    }

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var response: HTTPURLResponse?
    private var data = Data()
    private var completion: (([String: Any]) -> Void)?

    func start(_ request: URLRequest, configuration: URLSessionConfiguration = .ephemeral,
               completion: @escaping ([String: Any]) -> Void) {
        self.completion = completion
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForResource = 180
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() { task?.cancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        // Never forward a session cookie or mutation to any redirect target.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, let url = http.url, Self.isAccountURL(url),
              !(300..<400).contains(http.statusCode), response.expectedContentLength <= 8 * 1024 * 1024 else {
            completionHandler(.cancel)
            return
        }
        self.response = http
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard self.data.count + data.count <= 8 * 1024 * 1024 else { dataTask.cancel(); return }
        self.data.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            completion = nil
            data.removeAll()
            self.task = nil
            self.session = nil
            session.invalidateAndCancel()
        }
        guard error == nil, let response, let url = response.url else {
            completion?(["error": "Safari account request failed"])
            return
        }
        var fields: [String: String] = [:]
        var headers: [[String]] = []
        for (key, value) in response.allHeaderFields {
            let name = String(describing: key), value = String(describing: value)
            fields[name] = value
            if !["set-cookie", "content-length", "content-encoding", "transfer-encoding"].contains(name.lowercased()) {
                headers.append([name, value])
            }
        }
        let cookies: [[String: Any]] = HTTPCookie.cookies(withResponseHeaderFields: fields, for: url).compactMap { cookie in
            guard Self.isSessionCookie(cookie.name), ["readfrog.app", "api.readfrog.app"].contains(cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) else { return nil }
            var value: [String: Any] = ["name": cookie.name, "value": cookie.value,
                "domain": cookie.domain, "path": cookie.path, "secure": cookie.isSecure,
                "httpOnly": cookie.isHTTPOnly, "sameSite": "lax"]
            if let expires = cookie.expiresDate { value["expirationDate"] = expires.timeIntervalSince1970 }
            if let age = cookie.properties?[.maximumAge] as? String, let seconds = Double(age) {
                value["expirationDate"] = Date().timeIntervalSince1970 + seconds
            }
            // Foundation retains SameSite on supported macOS versions.
            if let sameSite = cookie.properties?[HTTPCookiePropertyKey("SameSite")] as? String {
                value["sameSite"] = ["strict": "strict", "none": "no_restriction"][sameSite.lowercased()] ?? "lax"
            }
            return value
        }
        completion?(["status": response.statusCode, "headers": headers,
                     "body": data.base64EncodedString(), "cookies": cookies])
    }
}

// AI subtitles on this Mac: the bundled yt-dlp fetches a YouTube video's audio,
// and a speech server the user runs (an OpenAI-compatible
// /v1/audio/transcriptions endpoint such as WhisperServer) returns timed segments.
// The extension stays light; no model runs inside the extension.
final class VideoTranscriber {
    static func isVideoID(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil
    }

    static func endpoint(_ raw: String) -> URL? {
        guard var components = URLComponents(string: raw), ["http", "https"].contains(components.scheme),
              components.host?.isEmpty == false, components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else { return nil }
        components.path = components.path.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
            + "/v1/audio/transcriptions"
        return components.url
    }

    static func isLanguage(_ value: String) -> Bool {
        value.range(of: #"^[a-z]{2,3}$"#, options: .regularExpression) != nil
    }

    /// Streams the multipart body to disk so long videos never sit in memory twice.
    static func writeMultipart(audio: URL, to body: URL, boundary: String, language: String?) throws {
        FileManager.default.createFile(atPath: body.path, contents: nil)
        let out = try FileHandle(forWritingTo: body)
        defer { try? out.close() }
        func text(_ string: String) throws { try out.write(contentsOf: Data(string.utf8)) }
        func field(_ name: String, _ value: String) throws {
            try text("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        try field("response_format", "verbose_json")
        if let language { try field("language", language) }
        try text("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(audio.lastPathComponent)\"\r\nContent-Type: application/octet-stream\r\n\r\n")
        let input = try FileHandle(forReadingFrom: audio)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { try out.write(contentsOf: chunk) }
        try text("\r\n--\(boundary)--\r\n")
    }

    static func segments(from data: Data) -> [String: Any] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = json["segments"] as? [[String: Any]] else {
            return ["error": "The speech server returned no timed segments"]
        }
        let segments: [[String: Any]] = raw.compactMap { segment in
            guard let start = (segment["start"] as? NSNumber)?.doubleValue,
                  let end = (segment["end"] as? NSNumber)?.doubleValue,
                  let text = segment["text"] as? String else { return nil }
            return ["start": start, "end": end, "text": text]
        }
        return ["segments": segments, "language": json["language"] as? String ?? ""]
    }

    // The work runs on its own thread; cancel() only flips state under the lock,
    // so it takes effect at once instead of queueing behind a running download.
    private let lock = NSLock()
    private var process: Process?
    private var task: URLSessionUploadTask?
    private var cancelled = false

    private var isCancelled: Bool { lock.withLock { cancelled } }

    func cancel() {
        transcriptionLog.info("cancel requested")
        let (process, task) = lock.withLock { () -> (Process?, URLSessionUploadTask?) in
            cancelled = true
            return (self.process, self.task)
        }
        process?.terminate()
        task?.cancel()
    }

    func start(videoID: String, endpoint: URL, apiKey: String?, language: String?,
               completion: @escaping ([String: Any]) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let work = FileManager.default.temporaryDirectory.appendingPathComponent("transcribe-" + UUID().uuidString)
            let began = Date()
            transcriptionLog.info("start \(videoID, privacy: .public) -> \(endpoint.host ?? "", privacy: .public)")
            func finish(_ result: [String: Any]) {
                try? FileManager.default.removeItem(at: work)
                let outcome = result["error"].map { "error: \($0)" }
                    ?? (result["cancelled"] != nil ? "cancelled" : "\((result["segments"] as? [Any])?.count ?? 0) segments")
                transcriptionLog.info("finish \(videoID, privacy: .public) after \(Int(Date().timeIntervalSince(began)))s: \(outcome, privacy: .public)")
                completion(result)
            }
            do {
                try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
                guard let tool = Bundle.main.resourceURL?.appendingPathComponent("yt-dlp/yt-dlp_macos"),
                      FileManager.default.isExecutableFile(atPath: tool.path) else {
                    return finish(["error": "yt-dlp is not bundled with this build"])
                }
                let process = Process()
                process.executableURL = tool
                process.arguments = ["--quiet", "--no-warnings", "--no-cache-dir", "--no-part", "--no-playlist",
                                     "--retries", "3", "--match-filter", "duration <= 14400",
                                     "-f", "bestaudio[ext=m4a]/bestaudio",
                                     "-o", work.appendingPathComponent("audio.%(ext)s").path,
                                     "--", "https://www.youtube.com/watch?v=" + videoID]
                var environment = ProcessInfo.processInfo.environment
                environment["TMPDIR"] = work.path + "/"
                process.environment = environment
                let errors = Pipe()
                process.standardOutput = FileHandle.nullDevice
                process.standardError = errors
                let proceed = self.lock.withLock { () -> Bool in
                    guard !self.cancelled else { return false }
                    self.process = process
                    return true
                }
                guard proceed else { return finish(["cancelled": true]) }
                try process.run()
                let stderr = errors.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                self.lock.withLock { self.process = nil }
                guard !self.isCancelled else { return finish(["cancelled": true]) }
                let audio = try FileManager.default.contentsOfDirectory(at: work, includingPropertiesForKeys: nil)
                    .first { $0.lastPathComponent.hasPrefix("audio.") }
                guard process.terminationStatus == 0, let audio else {
                    let reason = String(decoding: stderr, as: UTF8.self)
                        .split(separator: "\n").last.map(String.init) ?? "exit \(process.terminationStatus)"
                    return finish(["error": "Audio download failed: " + String(reason.prefix(300))])
                }

                transcriptionLog.info("audio \(videoID, privacy: .public) ready after \(Int(Date().timeIntervalSince(began)))s")
                let boundary = "readfrog-" + UUID().uuidString
                let body = work.appendingPathComponent("body")
                try Self.writeMultipart(audio: audio, to: body, boundary: boundary, language: language)
                var request = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1800)
                request.httpMethod = "POST"
                request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
                if let apiKey { request.setValue("Bearer " + apiKey, forHTTPHeaderField: "Authorization") }
                let configuration = URLSessionConfiguration.ephemeral
                // The server sends nothing until it has transcribed everything; the
                // 60 s default idle timeout would abort every long video.
                configuration.timeoutIntervalForRequest = 1800
                configuration.timeoutIntervalForResource = 1800
                let session = URLSession(configuration: configuration)
                let task = session.uploadTask(with: request, fromFile: body) { data, response, error in
                    session.finishTasksAndInvalidate()
                    self.lock.withLock { self.task = nil }
                    if self.isCancelled { return finish(["cancelled": true]) }
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard error == nil, (200..<300).contains(status), let data else {
                        let detail = error.map { $0.localizedDescription } ?? "HTTP \(status)"
                        return finish(["error": "Speech server request failed: " + detail])
                    }
                    finish(Self.segments(from: data))
                }
                let proceedUpload = self.lock.withLock { () -> Bool in
                    guard !self.cancelled else { return false }
                    self.task = task
                    return true
                }
                guard proceedUpload else {
                    session.invalidateAndCancel()
                    return finish(["cancelled": true])
                }
                task.resume()
            } catch {
                finish(["error": "Transcription failed: \(error.localizedDescription)"])
            }
        }
    }
}

/// Main-queue state for one transcription, collected by polling.
final class TranscriptionJob {
    let transcriber = VideoTranscriber()
    var result: [String: Any]?
    var finishedAt: Date?
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static var transcriptions: [String: TranscriptionJob] = [:]

    // Confine registry access to the main queue and namespace it by Safari
    // profile. No request can reuse another profile's session or cancel its work.
    private static var requests: [String: AccountHTTPTransport] = [:]

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        let profile = (item?.userInfo?[SFExtensionProfileKey] as? UUID)?.uuidString ?? "default"
        DispatchQueue.main.async {
            func reply(_ value: [String: Any]) {
                let item = NSExtensionItem()
                item.userInfo = [SFExtensionMessageKey: value]
                context.completeRequest(returningItems: [item], completionHandler: nil)
            }
            guard let message, let id = message["id"] as? String, UUID(uuidString: id) != nil else {
                reply(["error": "Invalid account message"])
                return
            }
            let key = profile + ":" + id
            switch message["type"] as? String {
            case "read-frog-transcribe-cancel":
                Self.transcriptions.removeValue(forKey: key)?.transcriber.cancel()
                reply(["cancelled": true])
                return
            case "read-frog-transcribe-status":
                // Jobs outlive single messages, so a long video never holds one reply open.
                guard let job = Self.transcriptions[key] else {
                    reply(["error": "Unknown transcription"])
                    return
                }
                if let result = job.result {
                    Self.transcriptions.removeValue(forKey: key)
                    reply(result)
                } else {
                    reply(["status": "running"])
                }
                return
            case "read-frog-transcribe-start":
                let apiKey = (message["apiKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                let language = (message["language"] as? String).flatMap { VideoTranscriber.isLanguage($0) ? $0 : nil }
                // Results nobody collected (a closed tab) are dropped after ten minutes.
                Self.transcriptions = Self.transcriptions.filter { $0.value.finishedAt.map { -$0.timeIntervalSinceNow < 600 } ?? true }
                guard let videoID = message["videoId"] as? String, VideoTranscriber.isVideoID(videoID),
                      let endpoint = (message["server"] as? String).flatMap(VideoTranscriber.endpoint),
                      apiKey.map({ !$0.contains("\r") && !$0.contains("\n") && $0.count <= 512 }) ?? true,
                      Self.transcriptions[key] == nil,
                      Self.transcriptions.values.filter({ $0.result == nil }).count < 4 else {
                    reply(["error": "Invalid transcription request"])
                    return
                }
                let job = TranscriptionJob()
                Self.transcriptions[key] = job
                job.transcriber.start(videoID: videoID, endpoint: endpoint, apiKey: apiKey, language: language) { result in
                    DispatchQueue.main.async {
                        job.result = result
                        job.finishedAt = Date()
                    }
                }
                reply(["started": true])
                return
            default:
                break
            }
            if message["type"] as? String == "read-frog-account-cancel" {
                Self.requests[key]?.cancel()
                reply(["cancelled": true])
                return
            }
            guard message["type"] as? String == "read-frog-account-fetch",
                  Self.requests[key] == nil, Self.requests.count < 32 else {
                reply(["error": "Invalid account request"])
                return
            }
            do {
                let request = try AccountHTTPTransport.makeRequest(message)
                let transport = AccountHTTPTransport()
                Self.requests[key] = transport
                transport.start(request) { result in
                    Self.requests.removeValue(forKey: key)
                    reply(result)
                }
            } catch {
                reply(["error": "Invalid account request"])
            }
        }
    }
}
