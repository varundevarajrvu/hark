package dev.vector.app

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/** Result of asking an address "are you a Vector server?". */
sealed interface ProbeResult {
    data object Ok : ProbeResult
    data object NotVector : ProbeResult
    data class Redirects(val to: Origin) : ProbeResult
    data class TlsFailure(val detail: String?) : ProbeResult
    data class Unreachable(val detail: String?) : ProbeResult
}

object ServerProbe {
    private const val TIMEOUT_MS = 8_000
    private const val MAX_BODY_CHARS = 4_096

    /**
     * Blocking: call from a background thread. Uses the platform HTTP stack with the system
     * trust store; certificate errors surface as [ProbeResult.TlsFailure] and are never bypassed.
     */
    fun probe(origin: Origin): ProbeResult {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("$origin/api/auth/me").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = false
                useCaches = false
                setRequestProperty("Accept", "application/json")
            }
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val buffer = CharArray(MAX_BODY_CHARS)
                val read = reader.read(buffer)
                if (read > 0) String(buffer, 0, read) else ""
            }.orEmpty()
            when (
                val verdict = classifyProbe(
                    probed = origin,
                    status = status,
                    contentType = connection.contentType,
                    body = body,
                    location = connection.getHeaderField("Location"),
                )
            ) {
                ProbeVerdict.IsVector -> ProbeResult.Ok
                ProbeVerdict.NotVector -> ProbeResult.NotVector
                is ProbeVerdict.Redirects -> ProbeResult.Redirects(verdict.to)
            }
        } catch (e: SSLException) {
            ProbeResult.TlsFailure(e.message)
        } catch (e: IOException) {
            // Cleartext blocked by policy, DNS failure, refused connection, timeout, …
            ProbeResult.Unreachable(e.message)
        } catch (e: SecurityException) {
            ProbeResult.Unreachable(e.message)
        } finally {
            connection?.disconnect()
        }
    }
}
