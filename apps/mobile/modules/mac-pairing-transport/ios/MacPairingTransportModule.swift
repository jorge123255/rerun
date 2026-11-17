import CryptoKit
import ExpoModulesCore
import Foundation
import Network
import Security

private let maxBodyBytes = 8 * 1024 * 1024
private let streamIdleSeconds: Double = 90

// A paired Mac serves its phone listener with a certificate it made for itself, so the system trust
// store cannot vouch for it. The pairing offer carries the SHA-256 of that certificate: a connection
// goes on only when the server presents exactly that certificate, still valid.
//
// The connection is opened with Network.framework and speaks HTTP/1.1 itself. URLSession would do
// both, but App Transport Security then judges the Mac's certificate by the rules of the public web,
// and only lets an address of the local network off them: a Mac reached at its Tailscale address
// (100.64.0.0/10) was refused after the pin had been accepted. Nothing here loosens those rules for
// the rest of the app: this path only ever talks to the one certificate named in the offer.
public class MacPairingTransportModule: Module {
  private let queue = DispatchQueue(label: "build.rerun.mac-pairing-transport")
  // Read and written on the queue only.
  private var calls: [String: PinnedCall] = [:]

  public func definition() -> ModuleDefinition {
    Name("MacPairingTransport")

    Events("onStreamLine", "onStreamEnd")

    AsyncFunction("request") { (id: String, url: String, pin: String, method: String, headers: [String: String], body: String?, timeoutMs: Double, promise: Promise) in
      guard let target = PinnedTarget(url: url), let head = httpRequestHead(method: method, target: target, headers: headers, bodyLength: body?.utf8.count) else {
        promise.reject("ERR_MAC_PAIRING_URL", "The Mac address is not an https address.")
        return
      }
      self.start(id: id, target: target, pin: pin, payload: head + (body?.data(using: .utf8) ?? Data()), seconds: max(1, timeoutMs / 1000), idle: false, onLine: nil) { outcome in
        switch outcome {
        case .success(let response): promise.resolve(["status": response.status, "body": String(data: response.body, encoding: .utf8) ?? ""])
        case .failure(let problem): promise.reject("ERR_MAC_PAIRING_REQUEST", problem.message)
        }
      }
    }

    // Lines of the reply arrive as onStreamLine events, and onStreamEnd closes the stream.
    AsyncFunction("openStream") { (id: String, url: String, pin: String, headers: [String: String]) in
      guard let target = PinnedTarget(url: url), let head = httpRequestHead(method: "GET", target: target, headers: headers, bodyLength: nil) else {
        self.sendEvent("onStreamEnd", ["id": id, "status": 0, "error": "The Mac address is not an https address."])
        return
      }
      let onLine: (String) -> Void = { [weak self] line in self?.sendEvent("onStreamLine", ["id": id, "line": line]) }
      self.start(id: id, target: target, pin: pin, payload: head, seconds: streamIdleSeconds, idle: true, onLine: onLine) { [weak self] outcome in
        switch outcome {
        case .success(let response): self?.sendEvent("onStreamEnd", ["id": id, "status": response.status])
        case .failure(let problem): self?.sendEvent("onStreamEnd", ["id": id, "status": problem.status, "error": problem.message])
        }
      }
    }

    AsyncFunction("cancel") { (id: String) in
      self.queue.async { self.calls[id]?.fail("cancelled") }
    }

    OnDestroy {
      self.queue.async { Array(self.calls.values).forEach { $0.fail("cancelled") } }
    }
  }

  // One connection per call, closed when the call ends: none is ever reused for another certificate.
  private func start(id: String, target: PinnedTarget, pin: String, payload: Data, seconds: Double, idle: Bool, onLine: ((String) -> Void)?, done: @escaping (Result<PinnedResponse, PinnedProblem>) -> Void) {
    let call = PinnedCall(target: target, pin: pin.lowercased(), payload: payload, seconds: seconds, idle: idle, queue: queue)
    call.onLine = onLine
    call.onDone = { [weak self] outcome in
      self?.calls[id] = nil
      done(outcome)
    }
    queue.async {
      self.calls[id] = call
      call.start()
    }
  }
}

private struct PinnedResponse {
  let status: Int
  let body: Data
}

private struct PinnedProblem: Error {
  let message: String
  let status: Int
}

private final class PinnedCall {
  var onDone: ((Result<PinnedResponse, PinnedProblem>) -> Void)?
  var onLine: ((String) -> Void)?

  private let target: PinnedTarget
  private let pin: String
  private let payload: Data
  private let seconds: Double
  private let idle: Bool
  private let queue: DispatchQueue
  private var connection: NWConnection?
  private var parser = HTTPResponseParser()
  private var body = Data()
  private var lines = Data()
  private var timer: DispatchWorkItem?
  private var finished = false
  // Why the certificate check failed, for the error the person sees.
  private var trustProblem: String?

  init(target: PinnedTarget, pin: String, payload: Data, seconds: Double, idle: Bool, queue: DispatchQueue) {
    self.target = target
    self.pin = pin
    self.payload = payload
    self.seconds = seconds
    self.idle = idle
    self.queue = queue
  }

  func start() {
    let tls = NWProtocolTLS.Options()
    sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
    sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { [weak self] _, trust, complete in
      complete(self?.trusted(sec_trust_copy_ref(trust).takeRetainedValue()) ?? false)
    }, queue)
    let tcp = NWProtocolTCP.Options()
    tcp.connectionTimeout = Int(min(seconds, 15))
    guard let port = NWEndpoint.Port(rawValue: target.port) else { return fail("The Mac address has no usable port.") }
    let connection = NWConnection(host: NWEndpoint.Host(target.host), port: port, using: NWParameters(tls: tls, tcp: tcp))
    self.connection = connection
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: self.send()
      // A connection that waits would try again by itself for as long as it lives: the call ends here.
      case .waiting(let error), .failed(let error): self.fail(self.describe(error))
      default: break
      }
    }
    arm()
    connection.start(queue: queue)
  }

  // Called on the queue. Ends the call once, whatever else is still on its way.
  func fail(_ message: String) {
    finish(.failure(PinnedProblem(message: message, status: parser.status)))
  }

  // Accepts the Mac only by the fingerprint in the code the person scanned: that is what proves this
  // is that Mac, since nobody issued its certificate. The certificate's dates and signature are then
  // checked with it as the only anchor. Nothing the system trusts is trusted here.
  private func trusted(_ trust: SecTrust) -> Bool {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
      trustProblem = "the Mac presented no certificate"
      return false
    }
    let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
    guard digest == pin else {
      trustProblem = "the Mac's certificate is not the one in the code"
      return false
    }
    guard SecTrustSetPolicies(trust, SecPolicyCreateBasicX509()) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [leaf] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
    else {
      trustProblem = "the certificate could not be set as the only anchor"
      return false
    }
    var failure: CFError?
    if SecTrustEvaluateWithError(trust, &failure) { return true }
    trustProblem = failure.map { CFErrorCopyDescription($0) as String } ?? "the certificate is not valid"
    return false
  }

  private func describe(_ error: NWError) -> String {
    "The secure connection to the Mac failed: \(error)." + (trustProblem.map { " Certificate: \($0)." } ?? "")
  }

  private func arm() {
    timer?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.fail("The Mac did not answer in time.") }
    timer = item
    queue.asyncAfter(deadline: .now() + seconds, execute: item)
  }

  private func send() {
    connection?.send(content: payload, completion: .contentProcessed { [weak self] error in
      guard let self else { return }
      if let error { self.fail(self.describe(error)) } else { self.receive() }
    })
  }

  private func receive() {
    connection?.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
      guard let self, !self.finished else { return }
      // A stream may sit quiet while the coworker thinks: each piece buys it the wait again.
      if self.idle { self.arm() }
      if let data, !data.isEmpty {
        do {
          self.take(try self.parser.feed(data))
        } catch {
          return self.fail("The Mac's answer could not be read: \(error).")
        }
        if self.finished { return }
        if self.parser.isComplete { return self.succeed() }
      }
      if complete || error != nil {
        // The Mac closed the connection: the answer is whole only if its length says so.
        if self.parser.endOfStream() { return self.succeed() }
        return self.fail(error.map { self.describe($0) } ?? "The Mac closed the connection before its answer was whole.")
      }
      self.receive()
    }
  }

  private func take(_ bytes: Data) {
    guard !bytes.isEmpty else { return }
    // A stream that was refused carries a short reason, not lines.
    guard let onLine, parser.status == 200 else {
      body.append(bytes)
      if body.count > maxBodyBytes { fail("The Mac sent too much.") }
      return
    }
    lines.append(bytes)
    // Whole lines only: a piece can end in the middle of a character.
    while let newline = lines.firstIndex(of: 0x0A) {
      let line = lines.subdata(in: lines.startIndex..<newline)
      lines.removeSubrange(lines.startIndex...newline)
      if let text = String(data: line, encoding: .utf8), !text.isEmpty { onLine(text) }
    }
    if lines.count > maxBodyBytes { fail("The Mac sent too much.") }
  }

  private func succeed() {
    finish(.success(PinnedResponse(status: parser.status, body: body)))
  }

  private func finish(_ outcome: Result<PinnedResponse, PinnedProblem>) {
    guard !finished else { return }
    finished = true
    timer?.cancel()
    connection?.stateUpdateHandler = nil
    connection?.cancel()
    connection = nil
    onDone?(outcome)
    onDone = nil
    onLine = nil
  }
}

// MARK: HTTP/1.1, as much of it as the Mac's phone listener speaks
// (kept free of the app's frameworks: tests/run.sh compiles everything below this line alone and checks it)

// Only an https address with a host and a port: the listener has no other.
struct PinnedTarget {
  let host: String
  let port: UInt16
  let path: String

  init?(url: String) {
    guard let parts = URLComponents(string: url), parts.scheme == "https", let host = parts.host, !host.isEmpty, let port = parts.port, (1...65535).contains(port), parts.user == nil, parts.password == nil else { return nil }
    self.host = host
    self.port = UInt16(port)
    let path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    self.path = path + (parts.percentEncodedQuery.map { "?\($0)" } ?? "")
  }

  var authority: String { host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)" }
}

// One request per connection. The listener answers only a Host that is its own address and port.
// Nothing is added that the caller did not ask for: no cookie, no credential, no cache header.
func httpRequestHead(method: String, target: PinnedTarget, headers: [String: String], bodyLength: Int?) -> Data? {
  let token = CharacterSet(charactersIn: "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
  let isToken = { (value: String) in !value.isEmpty && value.unicodeScalars.allSatisfy(token.contains) }
  guard isToken(method), !target.path.unicodeScalars.contains(where: { $0.value <= 0x20 || $0.value == 0x7F }) else { return nil }
  var lines = ["\(method) \(target.path) HTTP/1.1", "Host: \(target.authority)", "Connection: close", "Accept-Encoding: identity"]
  let owned: Set<String> = ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"]
  for (name, value) in headers.sorted(by: { $0.key < $1.key }) where !owned.contains(name.lowercased()) {
    // A line break in a header would let its value write a header, or a request, of its own.
    guard isToken(name), !value.unicodeScalars.contains(where: { ($0.value < 0x20 && $0.value != 0x09) || $0.value == 0x7F }) else { return nil }
    lines.append("\(name): \(value)")
  }
  if let bodyLength { lines.append("Content-Length: \(bodyLength)") }
  return (lines.joined(separator: "\r\n") + "\r\n\r\n").data(using: .utf8)
}

enum HTTPParseError: Error, CustomStringConvertible {
  case malformed(String)

  var description: String {
    switch self {
    case .malformed(let what): return what
    }
  }
}

// Fed the bytes of one response as they arrive, hands back the bytes of its body. The body ends by its
// Content-Length, by its last chunk, or, with neither, when the Mac closes the connection.
struct HTTPResponseParser {
  private enum Stage {
    case head
    case fixed(Int)
    case chunkSize
    case chunk(Int)
    case chunkEnd
    case trailers
    case untilClose
    case done
  }

  private(set) var status = 0
  private var stage = Stage.head
  private var pending = Data()
  private static let maxHeadBytes = 64 * 1024

  var isComplete: Bool {
    if case .done = stage { return true }
    return false
  }

  // The connection closed: true when the response was whole by then.
  mutating func endOfStream() -> Bool {
    if case .untilClose = stage { stage = .done }
    return isComplete
  }

  mutating func feed(_ data: Data) throws -> Data {
    pending.append(data)
    var body = Data()
    while true {
      switch stage {
      case .head:
        guard let end = pending.range(of: Data("\r\n\r\n".utf8)) else {
          if pending.count > Self.maxHeadBytes { throw HTTPParseError.malformed("its headers are too long") }
          return body
        }
        guard let head = String(data: pending.subdata(in: pending.startIndex..<end.lowerBound), encoding: .utf8) else { throw HTTPParseError.malformed("its headers are not text") }
        pending = pending.subdata(in: end.upperBound..<pending.endIndex)
        try readHead(head)
      case .fixed(let left):
        let taken = min(left, pending.count)
        body.append(pending.prefix(taken))
        pending = pending.subdata(in: (pending.startIndex + taken)..<pending.endIndex)
        stage = left == taken ? .done : .fixed(left - taken)
        if taken < left { return body }
      case .chunkSize:
        guard let line = takeLine() else { return body }
        // A chunk's size is hexadecimal, and may be followed by extensions nobody here reads.
        let digits = line.split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard !digits.isEmpty, digits.count <= 8, let size = Int(digits, radix: 16), size >= 0 else { throw HTTPParseError.malformed("a chunk has no size") }
        stage = size == 0 ? .trailers : .chunk(size)
      case .chunk(let left):
        let taken = min(left, pending.count)
        body.append(pending.prefix(taken))
        pending = pending.subdata(in: (pending.startIndex + taken)..<pending.endIndex)
        stage = left == taken ? .chunkEnd : .chunk(left - taken)
        if taken < left { return body }
      case .chunkEnd:
        guard pending.count >= 2 else { return body }
        guard pending.prefix(2) == Data("\r\n".utf8) else { throw HTTPParseError.malformed("a chunk does not end where it says") }
        pending = pending.subdata(in: (pending.startIndex + 2)..<pending.endIndex)
        stage = .chunkSize
      case .trailers:
        guard let line = takeLine() else { return body }
        if line.isEmpty { stage = .done }
      case .untilClose:
        body.append(pending)
        pending = Data()
        return body
      case .done:
        return body
      }
    }
  }

  private mutating func takeLine() -> String? {
    guard let end = pending.range(of: Data("\r\n".utf8)) else { return nil }
    let line = String(data: pending.subdata(in: pending.startIndex..<end.lowerBound), encoding: .utf8) ?? ""
    pending = pending.subdata(in: end.upperBound..<pending.endIndex)
    return line
  }

  private mutating func readHead(_ head: String) throws {
    var lines = head.components(separatedBy: "\r\n")
    let statusLine = lines.removeFirst().split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
    guard statusLine.count >= 2, statusLine[0].hasPrefix("HTTP/1."), statusLine[1].count == 3, let code = Int(statusLine[1]), (100...599).contains(code) else {
      throw HTTPParseError.malformed("it does not start with a status")
    }
    var length: Int?
    var chunked = false
    for line in lines {
      guard let colon = line.firstIndex(of: ":") else { throw HTTPParseError.malformed("a header has no name") }
      let name = line[..<colon].lowercased()
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      if name == "content-length" {
        guard !value.isEmpty, value.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }), let parsed = Int(value), length == nil || length == parsed else { throw HTTPParseError.malformed("its length is not a number") }
        length = parsed
      }
      if name == "transfer-encoding" {
        guard value.lowercased() == "chunked" else { throw HTTPParseError.malformed("it is encoded in a way this phone does not read") }
        chunked = true
      }
    }
    // An interim answer (100 Continue) is followed by the real one.
    if (100..<200).contains(code) { return }
    status = code
    if code == 204 || code == 304 { stage = .done } else if chunked { stage = .chunkSize } else if let length { stage = length == 0 ? .done : .fixed(length) } else { stage = .untilClose }
  }
}
