import Foundation

var failures = 0
var checks = 0
func expect(_ condition: @autoclosure () -> Bool, _ what: String, line: Int = #line) {
  checks += 1
  if !condition() { failures += 1; print("FAILED line \(line): \(what)") }
}

// Feeds a response in pieces of `step` bytes, as a connection would hand it over.
func read(_ response: String, step: Int, close: Bool = true) -> (status: Int, body: String, whole: Bool, error: String?) {
  var parser = HTTPResponseParser()
  var body = Data()
  let bytes = Array(response.utf8)
  var offset = 0
  do {
    while offset < bytes.count {
      let end = min(offset + step, bytes.count)
      body.append(try parser.feed(Data(bytes[offset..<end])))
      offset = end
    }
  } catch {
    return (parser.status, String(decoding: body, as: UTF8.self), false, "\(error)")
  }
  let whole = close ? parser.endOfStream() : parser.isComplete
  return (parser.status, String(decoding: body, as: UTF8.self), whole, nil)
}

let sizes = [1, 2, 3, 7, 64, 4096]

// What the Mac's listener sends for every JSON answer: a length and the body.
let json = "HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 27\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\nDate: Tue, 17 Nov 2026 12:00:00 GMT\r\nConnection: close\r\n\r\n{\"coworkers\":[{\"id\":\"é\"}]}"
for step in sizes {
  let got = read(json, step: step, close: false)
  expect(got.status == 200 && got.body == "{\"coworkers\":[{\"id\":\"é\"}]}" && got.whole && got.error == nil, "a JSON answer with a length, in pieces of \(step)")
}

// A refusal is the same shape with another status.
let refusal = "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 19\r\n\r\n{\"error\":\"revoked\"}"
for step in sizes {
  let got = read(refusal, step: step, close: false)
  expect(got.status == 401 && got.body == "{\"error\":\"revoked\"}" && got.whole, "a refusal, in pieces of \(step)")
}

// The reply stream: Node sends lines as chunks, and ends with an empty one.
let stream = "HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\ncache-control: no-store\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n" + "f\r\n{\"reset\":true}\n\r\n" + "1A;ext=1\r\n{\"delta\":\"Hello \\r\\n é\"}\n\r\n" + "0\r\n\r\n"
for step in sizes {
  let got = read(stream, step: step, close: false)
  expect(got.status == 200 && got.body == "{\"reset\":true}\n{\"delta\":\"Hello \\r\\n é\"}\n" && got.whole && got.error == nil, "a chunked stream, in pieces of \(step)")
}
expect(!read(String(stream.dropLast(5)), step: 5).whole, "a chunked stream cut before its last chunk is not whole")

// A stream with nothing to say, and an answer with an empty body.
for head in ["HTTP/1.1 204 No Content\r\ncache-control: no-store\r\nConnection: close\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"] {
  let got = read(head, step: 3, close: false)
  expect(got.whole && got.body.isEmpty && got.error == nil, "an answer with no body is whole at its headers")
}

// Neither a length nor chunks: the body runs until the Mac closes the connection.
let open = "HTTP/1.1 200 OK\r\ncontent-type: application/x-ndjson\r\n\r\n{\"delta\":\"a\"}\n"
expect(!read(open, step: 4, close: false).whole && read(open, step: 4, close: false).body == "{\"delta\":\"a\"}\n", "a body with no length is handed over as it comes")
expect(read(open, step: 4).whole, "and is whole once the connection closes")

// A length the body never reaches is not a whole answer.
let short = read("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", step: 2)
expect(!short.whole && short.body == "abc", "a body shorter than its length is not whole")
// Bytes after the stated length are not the body.
expect(read("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabcdef", step: 50).body == "abc", "nothing past the length is read")

// An interim answer is followed by the real one.
let interim = read("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 202 Accepted\r\nContent-Length: 2\r\n\r\n{}", step: 6, close: false)
expect(interim.status == 202 && interim.body == "{}" && interim.whole, "100 Continue is skipped")

// A redirect is an answer like any other: its status is handed back, and nothing is followed.
let redirect = read("HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\nContent-Length: 0\r\n\r\n", step: 9, close: false)
expect(redirect.status == 302 && redirect.whole, "a redirect is reported, not followed")

for (bad, why) in [
  ("SSH-2.0-OpenSSH\r\n\r\n", "not HTTP"), ("HTTP/1.1 abc OK\r\n\r\n", "no status"), ("HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", "negative length"),
  ("HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nab", "two lengths"), ("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", "an unknown encoding"),
  ("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n", "a chunk size that is not a number"), ("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\naXX", "a chunk longer than its size"),
  ("HTTP/1.1 200 OK\r\nno colon here\r\n\r\n", "a header with no name"), ("HTTP/1.1 200 OK\r\n" + String(repeating: "x", count: 70_000), "headers with no end"),
] {
  expect(read(bad, step: 11).error != nil, "refuses \(why)")
}

// The request: only https with a host and a port, and the Host the listener expects.
let target = PinnedTarget(url: "https://100.78.248.69:59852/api/mac-pairing/v1/workspaces/1/coworkers/a%20b/chats?x=1")
expect(target?.host == "100.78.248.69" && target?.port == 59852 && target?.path == "/api/mac-pairing/v1/workspaces/1/coworkers/a%20b/chats?x=1" && target?.authority == "100.78.248.69:59852", "an https address keeps its path as written")
expect(PinnedTarget(url: "https://192.168.1.74:59852")?.path == "/", "no path is the root")
for bad in ["http://192.168.1.74:59852/x", "https://192.168.1.74/x", "https://user:pw@192.168.1.74:1/x", "ftp://192.168.1.74:1/", "192.168.1.74:59852", "https://:59852/x", ""] {
  expect(PinnedTarget(url: bad) == nil, "refuses \(bad)")
}

let head = httpRequestHead(method: "POST", target: target!, headers: ["Authorization": "Bearer abc", "Content-Type": "application/json", "Host": "evil.example", "Connection": "keep-alive", "Content-Length": "999"], bodyLength: 12).map { String(decoding: $0, as: UTF8.self) }
expect(head == "POST /api/mac-pairing/v1/workspaces/1/coworkers/a%20b/chats?x=1 HTTP/1.1\r\nHost: 100.78.248.69:59852\r\nConnection: close\r\nAccept-Encoding: identity\r\nAuthorization: Bearer abc\r\nContent-Type: application/json\r\nContent-Length: 12\r\n\r\n", "the request names the listener as Host, closes, and states its own length")
let get = httpRequestHead(method: "GET", target: target!, headers: ["Accept": "application/json"], bodyLength: nil).map { String(decoding: $0, as: UTF8.self) } ?? ""
expect(!get.contains("Content-Length") && !get.lowercased().contains("cookie") && !get.lowercased().contains("origin"), "a request with no body states no length, and adds nothing of its own")
for (name, value) in [("X-Bad", "a\r\nHost: evil"), ("X-Bad", "a\nb"), ("Bad Name", "a"), ("Bad:Name", "a"), ("", "a")] {
  expect(httpRequestHead(method: "GET", target: target!, headers: [name: value], bodyLength: nil) == nil, "refuses a header that could write a line of its own")
}
expect(httpRequestHead(method: "GET /x HTTP/1.1\r\nX:", target: target!, headers: [:], bodyLength: nil) == nil, "refuses a method that is not a word")

print("\(checks - failures) of \(checks) checks passed")
exit(failures == 0 ? 0 : 1)
