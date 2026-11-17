package expo.modules.macpairingtransport

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

private const val MAX_BODY_BYTES = 8 * 1024 * 1024

class MacPairingTransportModule : Module() {
  private val executor = Executors.newCachedThreadPool()
  private val running = ConcurrentHashMap<String, HttpsURLConnection>()

  private fun readAll(stream: InputStream?): String {
    if (stream == null) return ""
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    stream.use {
      while (true) {
        val read = it.read(buffer)
        if (read < 0) break
        out.write(buffer, 0, read)
        if (out.size() > MAX_BODY_BYTES) throw IllegalStateException("The Mac sent too much.")
      }
    }
    return out.toString(Charsets.UTF_8.name())
  }

  private fun bodyOf(connection: HttpsURLConnection, status: Int): InputStream? =
    if (status >= 400) connection.errorStream else connection.inputStream

  override fun definition() = ModuleDefinition {
    Name("MacPairingTransport")

    Events("onStreamLine", "onStreamEnd")

    AsyncFunction("request") { id: String, url: String, pin: String, method: String, headers: Map<String, String>, body: String?, timeoutMs: Double, promise: Promise ->
      executor.execute {
        try {
          val connection = PinnedTls.open(url, pin)
          running[id] = connection
          connection.requestMethod = method
          connection.connectTimeout = timeoutMs.toInt()
          connection.readTimeout = timeoutMs.toInt()
          headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
          if (body != null) {
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
          }
          val status = connection.responseCode
          promise.resolve(mapOf("status" to status, "body" to readAll(bodyOf(connection, status))))
        } catch (error: Exception) {
          promise.reject("ERR_MAC_PAIRING_REQUEST", error.message ?: "The Mac did not answer.", error)
        } finally {
          running.remove(id)?.disconnect()
        }
      }
    }

    // Lines of the reply arrive as onStreamLine events, and onStreamEnd closes the stream.
    AsyncFunction("openStream") { id: String, url: String, pin: String, headers: Map<String, String> ->
      executor.execute {
        var status = 0
        var failure: String? = null
        try {
          val connection = PinnedTls.open(url, pin)
          running[id] = connection
          connection.connectTimeout = 10_000
          connection.readTimeout = 90_000
          headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
          status = connection.responseCode
          if (status == 200) {
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
              reader.forEachLine { line -> if (line.isNotEmpty()) sendEvent("onStreamLine", mapOf("id" to id, "line" to line)) }
            }
          }
        } catch (error: Exception) {
          failure = error.message ?: "The Mac did not answer."
        } finally {
          running.remove(id)?.disconnect()
          sendEvent("onStreamEnd", mapOf("id" to id, "status" to status, "error" to failure))
        }
      }
    }

    AsyncFunction("cancel") { id: String ->
      val connection = running.remove(id)
      if (connection != null) executor.execute { connection.disconnect() }
    }

    OnDestroy {
      running.values.forEach { it.disconnect() }
      running.clear()
      executor.shutdownNow()
    }
  }
}
