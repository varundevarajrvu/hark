package dev.vector.app

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * Pure address logic: no Android classes, so everything here runs in plain JVM unit tests.
 *
 * Two jobs:
 *  - turn what the user typed on the setup screen into a canonical origin (`scheme://host[:port]`);
 *  - decide, for every navigation the WebView attempts, whether it stays in the app.
 *
 * Parsing is deliberately strict. Anything `java.net.URI` cannot parse into a plain
 * `scheme://host[:port]` authority (backslashes, control characters, userinfo, odd host
 * characters) is treated as "not our server" rather than guessed at.
 */

/** A canonical web origin. [host] is lower-case; IPv6 literals keep their brackets. */
data class Origin(val scheme: String, val host: String, val port: Int) {
    val isCleartext: Boolean get() = scheme == "http"

    override fun toString(): String =
        if (port == defaultPort(scheme)) "$scheme://$host" else "$scheme://$host:$port"

    companion object {
        fun defaultPort(scheme: String): Int = if (scheme == "https") 443 else 80

        /**
         * The origin of an absolute http(s) URL, or null when the URL is not http(s), cannot be
         * parsed strictly, or carries userinfo (`http://my-server@evil.com`).
         */
        fun of(url: String): Origin? {
            val uri = try {
                URI(url)
            } catch (_: URISyntaxException) {
                return null
            }
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
            if (scheme != "http" && scheme != "https") return null
            // rawAuthority is checked as well as userInfo: for authorities java.net.URI treats as
            // "registry based" userInfo is null even though an '@' is present.
            if (uri.rawUserInfo != null || uri.rawAuthority?.contains('@') == true) return null
            val host = uri.host?.lowercase(Locale.ROOT)?.trimEnd('.') ?: return null
            if (host.isEmpty()) return null
            val port = if (uri.port == -1) defaultPort(scheme) else uri.port
            if (port !in 1..65535) return null
            return Origin(scheme, host, port)
        }
    }
}

sealed interface AddressResult {
    data class Ok(val origin: Origin) : AddressResult
    data class Invalid(val reason: Reason) : AddressResult

    enum class Reason { EMPTY, UNSUPPORTED_SCHEME, HAS_CREDENTIALS, MALFORMED }
}

private val EXPLICIT_SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://")

/**
 * Normalises setup-screen input into an origin.
 *
 * `192.168.1.20:8787`, `http://…` and `https://…` are accepted. Without a scheme the default is
 * https, except for private/LAN hosts ([isPrivateHost]) where it is http, because a server on
 * home Wi-Fi almost never has a certificate. Any path, query or fragment is dropped.
 */
fun normalizeServerAddress(input: String): AddressResult {
    val text = input.trim()
    if (text.isEmpty()) return AddressResult.Invalid(AddressResult.Reason.EMPTY)
    if (text.any { it.isWhitespace() || it == '\\' || it.isISOControl() }) {
        return AddressResult.Invalid(AddressResult.Reason.MALFORMED)
    }

    val explicit = EXPLICIT_SCHEME.find(text)?.groupValues?.get(1)?.lowercase(Locale.ROOT)
    if (explicit != null && explicit != "http" && explicit != "https") {
        return AddressResult.Invalid(AddressResult.Reason.UNSUPPORTED_SCHEME)
    }
    // "mailto:x", "javascript:alert(1)" and friends: a scheme without "//" that is not host:port.
    if (explicit == null && Regex("^[A-Za-z][A-Za-z0-9+.-]*:(?![0-9]{1,5}(/|\\?|#|$))").containsMatchIn(text)) {
        return AddressResult.Invalid(AddressResult.Reason.UNSUPPORTED_SCHEME)
    }

    val withScheme = if (explicit != null) text else "https://$text"
    if (authorityOf(withScheme).contains('@')) {
        return AddressResult.Invalid(AddressResult.Reason.HAS_CREDENTIALS)
    }
    val parsed = Origin.of(withScheme) ?: return AddressResult.Invalid(AddressResult.Reason.MALFORMED)
    if (!isPlausibleHost(parsed.host)) return AddressResult.Invalid(AddressResult.Reason.MALFORMED)

    if (explicit != null) return AddressResult.Ok(parsed)

    // No scheme typed: choose one, and re-derive the port if it was only the https default.
    val scheme = if (isPrivateHost(parsed.host)) "http" else "https"
    val typedPort = try {
        URI(withScheme).port
    } catch (_: URISyntaxException) {
        -1
    }
    val port = if (typedPort == -1) Origin.defaultPort(scheme) else typedPort
    return AddressResult.Ok(Origin(scheme, parsed.host, port))
}

private fun authorityOf(url: String): String {
    val start = url.indexOf("://") + 3
    val end = url.indexOfAny(charArrayOf('/', '?', '#'), start).let { if (it == -1) url.length else it }
    return url.substring(start, end)
}

private fun isPlausibleHost(host: String): Boolean {
    if (host.startsWith("[")) return host.endsWith("]")
    if (host.length > 253 || host.startsWith(".") || host.contains("..")) return false
    // All-numeric dotted hosts must be a real IPv4 address, not "1.2.3" or "999.1.1.1".
    if (host.all { it.isDigit() || it == '.' }) return parseIpv4(host) != null
    return host.all { it.isLetterOrDigit() || it == '-' || it == '.' }
}

private fun parseIpv4(host: String): IntArray? {
    val parts = host.split('.')
    if (parts.size != 4) return null
    val octets = IntArray(4)
    for ((i, part) in parts.withIndex()) {
        if (part.isEmpty() || part.length > 3 || !part.all { it.isDigit() }) return null
        val n = part.toInt()
        if (n > 255) return null
        octets[i] = n
    }
    return octets
}

/**
 * True for hosts that are only reachable on a private network: loopback, RFC 1918, link-local,
 * CGNAT (100.64/10, used by Tailscale and similar VPNs), IPv6 loopback/ULA/link-local, and names
 * that only resolve locally (`localhost`, single-label names, `.local`, `.lan`, `.home.arpa`,
 * `.internal`).
 */
fun isPrivateHost(host: String): Boolean {
    val h = host.lowercase(Locale.ROOT).trimEnd('.')
    if (h.startsWith("[") && h.endsWith("]")) {
        val v6 = h.substring(1, h.length - 1).substringBefore('%')
        if (v6 == "::1") return true
        val first = v6.substringBefore(':').toIntOrNull(16) ?: return false
        return (first and 0xfe00) == 0xfc00 || (first and 0xffc0) == 0xfe80
    }
    parseIpv4(h)?.let { (a, b) ->
        return a == 10 || a == 127 ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            (a == 169 && b == 254) ||
            (a == 100 && b in 64..127)
    }
    if (h == "localhost" || !h.contains('.')) return true
    return h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".localhost") ||
        h.endsWith(".home.arpa") || h.endsWith(".internal")
}

/** What the WebView does with a URL it is asked to navigate to. */
enum class NavigationDecision {
    /** Same origin as the saved server: load it in the WebView. */
    STAY,

    /** Some other http(s) site: hand it to the user's browser. */
    EXTERNAL,

    /** Not http(s) (intent:, file:, content:, javascript:, data:, …) or unparseable: refuse. */
    BLOCK,
}

/**
 * Navigation policy for top-level loads. Only an exact origin match (scheme, host and effective
 * port) stays in the app; the server's origin appearing elsewhere in a URL
 * (`https://evil.com/?x=http://my-server`, `http://my-server@evil.com`, `my-server.evil.com`)
 * never counts.
 */
fun decideNavigation(server: Origin, url: String): NavigationDecision {
    val scheme = url.trimStart().substringBefore(':', "").lowercase(Locale.ROOT)
    if (scheme != "http" && scheme != "https") return NavigationDecision.BLOCK
    val target = Origin.of(url.trim())
    return when {
        target == server -> NavigationDecision.STAY
        // Unparseable or credential-bearing http(s) URLs are refused rather than forwarded.
        target == null -> NavigationDecision.BLOCK
        else -> NavigationDecision.EXTERNAL
    }
}

/** Sub-frame loads are governed by the server's own CSP; the app only refuses non-web schemes. */
fun isWebUrl(url: String): Boolean {
    val scheme = url.trimStart().substringBefore(':', "").lowercase(Locale.ROOT)
    return scheme == "http" || scheme == "https"
}

/** Outcome of probing `GET <origin>/api/auth/me`. */
sealed interface ProbeVerdict {
    data object IsVector : ProbeVerdict
    data object NotVector : ProbeVerdict

    /** The server answered with a redirect to another origin (typically http → https). */
    data class Redirects(val to: Origin) : ProbeVerdict
}

/**
 * Classifies a probe response. A Vector server answers `/api/auth/me` with JSON and status 200
 * (signed in or anonymous) or 401 (sign-in required). Anything else — an HTML router page, a
 * captive portal, some other web server's 404 — is not Vector.
 */
fun classifyProbe(
    probed: Origin,
    status: Int,
    contentType: String?,
    body: String,
    location: String?,
): ProbeVerdict {
    if (status in 300..399 && location != null) {
        val target = Origin.of(location.trim())
        if (target != null && target != probed) return ProbeVerdict.Redirects(target)
        return ProbeVerdict.NotVector
    }
    if (status != 200 && status != 401) return ProbeVerdict.NotVector
    val isJsonType = contentType?.lowercase(Locale.ROOT)?.contains("json") == true
    val trimmed = body.trimStart('﻿', ' ', '\t', '\r', '\n')
    val looksJson = trimmed.startsWith("{") || trimmed.startsWith("[")
    return if (isJsonType && looksJson) ProbeVerdict.IsVector else ProbeVerdict.NotVector
}
