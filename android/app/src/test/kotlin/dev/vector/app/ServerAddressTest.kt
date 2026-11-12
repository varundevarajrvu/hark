package dev.vector.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {

    private fun ok(input: String): String {
        val result = normalizeServerAddress(input)
        assertTrue("expected Ok for '$input' but was $result", result is AddressResult.Ok)
        return (result as AddressResult.Ok).origin.toString()
    }

    private fun invalid(input: String): AddressResult.Reason {
        val result = normalizeServerAddress(input)
        assertTrue("expected Invalid for '$input' but was $result", result is AddressResult.Invalid)
        return (result as AddressResult.Invalid).reason
    }

    // ---- normalisation -------------------------------------------------------------------

    @Test fun lanAddressWithPortDefaultsToHttp() {
        assertEquals("http://192.168.1.20:8787", ok("192.168.1.20:8787"))
        assertEquals("http://10.0.2.2:8787", ok("  10.0.2.2:8787  "))
        assertEquals("http://172.16.4.1:8787", ok("172.16.4.1:8787"))
        assertEquals("http://100.101.102.103:8787", ok("100.101.102.103:8787"))
        assertEquals("http://localhost:8787", ok("localhost:8787"))
        assertEquals("http://laptop:8787", ok("laptop:8787"))
        assertEquals("http://laptop.local:8787", ok("laptop.local:8787"))
        assertEquals("http://[fd12::1]:8787", ok("[fd12::1]:8787"))
    }

    @Test fun lanAddressWithoutPortUsesHttpDefaultPort() {
        assertEquals("http://192.168.1.20", ok("192.168.1.20"))
    }

    @Test fun publicHostDefaultsToHttps() {
        assertEquals("https://vector.example.com", ok("vector.example.com"))
        assertEquals("https://vector.example.com:8443", ok("vector.example.com:8443"))
        assertEquals("https://8.8.8.8:8787", ok("8.8.8.8:8787"))
        assertEquals("https://172.32.0.1", ok("172.32.0.1"))
        assertEquals("https://100.128.0.1", ok("100.128.0.1"))
    }

    @Test fun explicitSchemeIsKept() {
        assertEquals("http://vector.example.com", ok("http://vector.example.com"))
        assertEquals("https://192.168.1.20:8787", ok("https://192.168.1.20:8787"))
        assertEquals("http://192.168.1.20:8787", ok("HTTP://192.168.1.20:8787"))
    }

    @Test fun defaultPortsAreDropped() {
        assertEquals("https://vector.example.com", ok("https://vector.example.com:443"))
        assertEquals("http://192.168.1.20", ok("http://192.168.1.20:80"))
        assertEquals("http://vector.example.com:443", ok("http://vector.example.com:443"))
    }

    @Test fun hostIsLowercasedAndPathDropped() {
        assertEquals("https://vector.example.com", ok("Vector.Example.COM"))
        assertEquals("https://vector.example.com", ok("https://vector.example.com/login?next=/x#top"))
        assertEquals("http://192.168.1.20:8787", ok("192.168.1.20:8787/"))
        assertEquals("https://vector.example.com", ok("vector.example.com."))
    }

    @Test fun rejectsEmptyAndMalformed() {
        assertEquals(AddressResult.Reason.EMPTY, invalid("   "))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("my server"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("http://"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("host:99999"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("999.1.1.1"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("1.2.3"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("exa_mple.com"))
        assertEquals(AddressResult.Reason.MALFORMED, invalid("http://my-server\\@evil.com"))
    }

    @Test fun rejectsOtherSchemes() {
        assertEquals(AddressResult.Reason.UNSUPPORTED_SCHEME, invalid("ftp://example.com"))
        assertEquals(AddressResult.Reason.UNSUPPORTED_SCHEME, invalid("file:///sdcard/x.html"))
        assertEquals(AddressResult.Reason.UNSUPPORTED_SCHEME, invalid("javascript:alert(1)"))
        assertEquals(AddressResult.Reason.UNSUPPORTED_SCHEME, invalid("intent://x#Intent;end"))
    }

    @Test fun rejectsCredentials() {
        assertEquals(AddressResult.Reason.HAS_CREDENTIALS, invalid("http://user:pw@192.168.1.20:8787"))
        assertEquals(AddressResult.Reason.HAS_CREDENTIALS, invalid("my-server@evil.com"))
    }

    // ---- private host detection ----------------------------------------------------------

    @Test fun privateHosts() {
        for (h in listOf(
            "10.1.2.3", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1",
            "100.64.0.1", "100.127.255.255", "localhost", "nas", "nas.local", "box.lan",
            "x.home.arpa", "[::1]", "[fe80::1]", "[fd00::1]", "[fc00::1]",
        )) assertTrue(h, isPrivateHost(h))
        for (h in listOf(
            "11.1.2.3", "172.15.0.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "100.128.0.1",
            "example.com", "192.168.1.20.example.com", "[2001:db8::1]", "local.example.com",
        )) assertFalse(h, isPrivateHost(h))
    }

    // ---- origin parsing ------------------------------------------------------------------

    @Test fun originOf() {
        assertEquals(Origin("http", "my-server", 8787), Origin.of("http://my-server:8787/a/b?c#d"))
        assertEquals(Origin("https", "my-server", 443), Origin.of("HTTPS://MY-SERVER/"))
        assertNull(Origin.of("http://my-server@evil.com/"))
        assertNull(Origin.of("http://user:pw@my-server/"))
        assertNull(Origin.of("ftp://my-server/"))
        assertNull(Origin.of("/relative/path"))
        assertNull(Origin.of("http://my server/"))
        assertNull(Origin.of("http:///nohost"))
    }

    // ---- navigation policy ---------------------------------------------------------------

    private val server = Origin("http", "my-server", 8787)

    private fun nav(url: String) = decideNavigation(server, url)

    @Test fun sameOriginStays() {
        assertEquals(NavigationDecision.STAY, nav("http://my-server:8787"))
        assertEquals(NavigationDecision.STAY, nav("http://my-server:8787/"))
        assertEquals(NavigationDecision.STAY, nav("http://my-server:8787/threads/1?x=1#/sheet"))
        assertEquals(NavigationDecision.STAY, nav("HTTP://MY-SERVER:8787/Path"))
        assertEquals(NavigationDecision.STAY, nav("http://My-Server.:8787/"))
    }

    @Test fun defaultPortIsEquivalentToExplicitDefaultPort() {
        val https = Origin("https", "vector.example.com", 443)
        assertEquals(NavigationDecision.STAY, decideNavigation(https, "https://vector.example.com/"))
        assertEquals(NavigationDecision.STAY, decideNavigation(https, "https://vector.example.com:443/x"))
        assertEquals(NavigationDecision.EXTERNAL, decideNavigation(https, "https://vector.example.com:8443/x"))
    }

    @Test fun serverOriginInsideAnotherUrlDoesNotCount() {
        assertEquals(NavigationDecision.EXTERNAL, nav("http://evil.com/?x=http://my-server:8787"))
        assertEquals(NavigationDecision.EXTERNAL, nav("https://evil.com/http://my-server:8787/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("http://evil.com/#http://my-server:8787/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("http://my-server.evil.com:8787/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("http://evil-my-server:8787/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("http://my-server:8787.evil.com/".replace(":8787.", ".")))
    }

    @Test fun userinfoTricksNeverStay() {
        assertEquals(NavigationDecision.BLOCK, nav("http://my-server@evil.com"))
        assertEquals(NavigationDecision.BLOCK, nav("http://my-server:8787@evil.com/"))
        assertEquals(NavigationDecision.BLOCK, nav("http://my-server%3A8787@evil.com/"))
        // Even credentials in front of the real server are refused rather than trusted.
        assertEquals(NavigationDecision.BLOCK, nav("http://user:pw@my-server:8787/"))
        assertEquals(NavigationDecision.BLOCK, nav("http://my-server:8787\\@evil.com/"))
    }

    @Test fun differingPortOrSchemeIsExternal() {
        assertEquals(NavigationDecision.EXTERNAL, nav("http://my-server:8788/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("http://my-server/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("https://my-server:8787/"))
        assertEquals(NavigationDecision.EXTERNAL, nav("https://example.com/docs"))
    }

    @Test fun nonWebSchemesAreBlocked() {
        for (url in listOf(
            "intent://my-server:8787/#Intent;scheme=http;package=com.evil;end",
            "file:///data/data/dev.vector.app/shared_prefs/vector.xml",
            "content://media/external/file/1",
            "javascript:alert(document.cookie)",
            "data:text/html,<script>alert(1)</script>",
            "market://details?id=com.evil",
            "mailto:someone@example.com",
            "tel:+15551234567",
            "about:blank",
            "blob:http://my-server:8787/uuid",
            "",
            "my-server:8787/path",
            "//my-server:8787/path",
        )) assertEquals(url, NavigationDecision.BLOCK, nav(url))
    }

    @Test fun webUrlCheck() {
        assertTrue(isWebUrl("https://cdn.example.com/x.js"))
        assertTrue(isWebUrl("HTTP://x/"))
        assertFalse(isWebUrl("intent://x"))
        assertFalse(isWebUrl("file:///x"))
        assertFalse(isWebUrl("httpx://x"))
    }

    // ---- probe classification ------------------------------------------------------------

    private val probed = Origin("http", "192.168.1.20", 8787)

    @Test fun vectorAnswersAreAccepted() {
        assertEquals(
            ProbeVerdict.IsVector,
            classifyProbe(probed, 200, "application/json; charset=utf-8", """{"user":null}""", null),
        )
        assertEquals(
            ProbeVerdict.IsVector,
            classifyProbe(probed, 401, "application/json", """ {"error":"Please sign in."}""", null),
        )
    }

    @Test fun otherAnswersAreNotVector() {
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 200, "text/html", "<html>router</html>", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 200, "application/json", "<html>", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 200, null, "{}", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 404, "application/json", "{}", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 500, "application/json", "{}", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 302, "text/html", "", null))
        assertEquals(ProbeVerdict.NotVector, classifyProbe(probed, 302, "text/html", "", "/login"))
    }

    @Test fun redirectToAnotherOriginIsReported() {
        assertEquals(
            ProbeVerdict.Redirects(Origin("https", "192.168.1.20", 443)),
            classifyProbe(probed, 301, "text/html", "", "https://192.168.1.20/api/auth/me"),
        )
    }
}
