package expo.modules.macpairingtransport

import java.net.URL
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

// A paired Mac serves its phone listener with a certificate it made for itself. The pairing offer
// carries the SHA-256 of that certificate: a connection goes on only when the server presents exactly
// that certificate, still valid, for the address asked.
object PinnedTls {
  // The entry type of an IP address in a certificate's subject alternative names.
  private const val SAN_IP_ADDRESS = 7

  fun fingerprint(certificate: X509Certificate): String =
    MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }

  fun names(certificate: X509Certificate, host: String): Boolean =
    certificate.subjectAlternativeNames?.any { it[0] == SAN_IP_ADDRESS && it[1] == host } == true

  private class PinnedTrust(private val pin: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      throw CertificateException("A paired Mac never asks the phone for a certificate.")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
      val leaf = chain?.firstOrNull() ?: throw CertificateException("The Mac presented no certificate.")
      leaf.checkValidity()
      if (!MessageDigest.isEqual(fingerprint(leaf).toByteArray(), pin.toByteArray())) {
        throw CertificateException("This is not the certificate the Mac showed when pairing.")
      }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }

  fun open(url: String, pin: String): HttpsURLConnection {
    val target = URL(url)
    require(target.protocol == "https") { "The Mac address is not an https address." }
    val context = SSLContext.getInstance("TLS")
    context.init(null, arrayOf(PinnedTrust(pin.lowercase())), null)
    val connection = target.openConnection() as HttpsURLConnection
    connection.sslSocketFactory = context.socketFactory
    connection.hostnameVerifier = HostnameVerifier { host, session ->
      val leaf = session.peerCertificates.firstOrNull() as? X509Certificate
      leaf != null && names(leaf, host)
    }
    // The Mac never redirects: following one would send the phone's token somewhere else.
    connection.instanceFollowRedirects = false
    connection.useCaches = false
    return connection
  }
}
