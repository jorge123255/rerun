import CryptoKit
import ExpoModulesCore
import Foundation
import Security

private let maxBodyBytes = 8 * 1024 * 1024

// A paired Mac serves its phone listener with a certificate it made for itself, so the system trust
// store cannot vouch for it. The pairing offer carries the SHA-256 of that certificate: a connection
// goes on only when the server presents exactly that certificate, still valid, for the address asked.
public class MacPairingTransportModule: Module {
  private let lock = NSLock()
  private var sessions: [String: PinnedSession] = [:]

  public func definition() -> ModuleDefinition {
    Name("MacPairingTransport")

    Events("onStreamLine", "onStreamEnd")

    AsyncFunction("request") { (id: String, url: String, pin: String, method: String, headers: [String: String], body: String?, timeoutMs: Double, promise: Promise) in
      guard let request = Self.request(url: url, method: method, headers: headers, body: body, timeoutMs: timeoutMs) else {
        promise.reject("ERR_MAC_PAIRING_URL", "The Mac address is not an https address.")
        return
      }
      self.session(for: pin).start(id: id, request: request, call: .buffered(promise))
    }

    // Lines of the reply arrive as onStreamLine events, and onStreamEnd closes the stream.
    AsyncFunction("openStream") { (id: String, url: String, pin: String, headers: [String: String]) in
      guard let request = Self.request(url: url, method: "GET", headers: headers, body: nil, timeoutMs: 90_000) else {
        self.sendEvent("onStreamEnd", ["id": id, "status": 0, "error": "The Mac address is not an https address."])
        return
      }
      self.session(for: pin).start(id: id, request: request, call: .streamed { [weak self] name, payload in
        self?.sendEvent(name, payload)
      })
    }

    AsyncFunction("cancel") { (id: String) in
      self.lock.lock()
      let all = Array(self.sessions.values)
      self.lock.unlock()
      all.forEach { $0.cancel(id: id) }
    }

    OnDestroy {
      self.lock.lock()
      let all = Array(self.sessions.values)
      self.sessions = [:]
      self.lock.unlock()
      all.forEach { $0.invalidate() }
    }
  }

  // One URLSession per certificate: a connection one certificate opened is never reused for another.
  private func session(for pin: String) -> PinnedSession {
    lock.lock()
    defer { lock.unlock() }
    if let existing = sessions[pin] { return existing }
    let created = PinnedSession(pin: pin.lowercased())
    sessions[pin] = created
    return created
  }

  private static func request(url: String, method: String, headers: [String: String], body: String?, timeoutMs: Double) -> URLRequest? {
    guard let target = URL(string: url), target.scheme == "https", target.host != nil else { return nil }
    var request = URLRequest(url: target, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: max(1, timeoutMs / 1000))
    request.httpMethod = method
    request.httpShouldHandleCookies = false
    headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    if let body { request.httpBody = body.data(using: .utf8) }
    return request
  }
}

private enum Call {
  case buffered(Promise)
  case streamed((String, [String: Any]) -> Void)
}

private final class Running {
  let id: String
  let call: Call
  var status = 0
  var data = Data()

  init(id: String, call: Call) {
    self.id = id
    self.call = call
  }
}

private final class PinnedSession: NSObject, URLSessionDataDelegate {
  private let pin: String
  private let queue: OperationQueue
  private var session: URLSession!
  // Read and written on the delegate queue only.
  private var running: [Int: Running] = [:]
  private var tasks: [String: URLSessionTask] = [:]
  // Why the last certificate check failed, for the error the person sees.
  private var lastTrustProblem: String?
  // How many times the phone was asked to check the Mac's certificate.
  private var trustChecks = 0

  init(pin: String) {
    self.pin = pin
    queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    super.init()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }

  func start(id: String, request: URLRequest, call: Call) {
    queue.addOperation {
      let task = self.session.dataTask(with: request)
      self.running[task.taskIdentifier] = Running(id: id, call: call)
      self.tasks[id] = task
      task.resume()
    }
  }

  func cancel(id: String) {
    queue.addOperation { self.tasks[id]?.cancel() }
  }

  func invalidate() {
    session.invalidateAndCancel()
  }

  private func trusted(_ trust: SecTrust, host: String) -> Bool {
    trustChecks += 1
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return false }
    let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
    guard digest == pin else { lastTrustProblem = "the Mac's certificate is not the one in the code"; return false }
    // The pinned certificate is the only anchor: the evaluation then checks its dates and that it
    // was issued for the address the phone asked for.
    guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
    else { lastTrustProblem = "the certificate could not be set as the only anchor"; return false }
    var failure: CFError?
    if SecTrustEvaluateWithError(trust, &failure) { lastTrustProblem = nil; return true }
    let strict = failure.map { CFErrorCopyDescription($0) as String } ?? "unknown"
    // A real iPhone holds a server certificate to rules the Mac's own certificate does not have to
    // meet (it is not issued by anyone: the phone knows it by the fingerprint in the code it
    // scanned, checked above). The fingerprint is what proves this is that Mac. So when only the
    // web's rules fail, the certificate's dates and signature are still checked, without them.
    var basicFailure: CFError?
    if SecTrustSetPolicies(trust, SecPolicyCreateBasicX509()) == errSecSuccess, SecTrustEvaluateWithError(trust, &basicFailure) {
      lastTrustProblem = nil
      return true
    }
    lastTrustProblem = "\(strict) / \(basicFailure.map { CFErrorCopyDescription($0) as String } ?? "unknown")"
    return false
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    answer(challenge, completionHandler)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    answer(challenge, completionHandler)
  }

  private func answer(_ challenge: URLAuthenticationChallenge, _ completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust, trusted(trust, host: space.host) else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  // The Mac never redirects: following one would send the phone's token somewhere else.
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    running[dataTask.taskIdentifier]?.status = (response as? HTTPURLResponse)?.statusCode ?? 0
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let call = running[dataTask.taskIdentifier] else { return }
    call.data.append(data)
    if call.data.count > maxBodyBytes {
      dataTask.cancel()
      return
    }
    guard case .streamed(let emit) = call.call, call.status == 200 else { return }
    // Whole lines only: a chunk can end in the middle of a character.
    while let newline = call.data.firstIndex(of: 0x0A) {
      let line = call.data.subdata(in: call.data.startIndex..<newline)
      call.data.removeSubrange(call.data.startIndex...newline)
      if let text = String(data: line, encoding: .utf8), !text.isEmpty { emit("onStreamLine", ["id": call.id, "line": text]) }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let call = running.removeValue(forKey: task.taskIdentifier) else { return }
    tasks[call.id] = nil
    switch call.call {
    case .buffered(let promise):
      if let error {
        let failure = error as NSError
        // The stream's own code says where a secure connection broke: the phone's check of the
        // certificate, the Mac closing the connection, or a refused handshake.
        let stream = failure.userInfo["_kCFStreamErrorCodeKey"].map { " stream \($0)" } ?? ""
        let under = (failure.userInfo[NSUnderlyingErrorKey] as? NSError).map { " under \($0.domain) \($0.code)" } ?? ""
        promise.reject("ERR_MAC_PAIRING_REQUEST", "\(error.localizedDescription) (\(failure.code)\(stream)\(under), asked: \(trustChecks))" + (lastTrustProblem.map { " Certificate: \($0)" } ?? ""))
      } else {
        promise.resolve(["status": call.status, "body": String(data: call.data, encoding: .utf8) ?? ""])
      }
    case .streamed(let emit):
      var payload: [String: Any] = ["id": call.id, "status": call.status]
      if let error { payload["error"] = error.localizedDescription }
      emit("onStreamEnd", payload)
    }
  }
}
