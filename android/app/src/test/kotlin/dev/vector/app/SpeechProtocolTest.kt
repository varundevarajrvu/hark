package dev.vector.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SpeechProtocolTest {

    // ---- requests ------------------------------------------------------------------------

    @Test fun validStartIsAccepted() {
        assertEquals("abc-1", speechStartId(mapOf("type" to "speech.start", "id" to "abc-1")))
        val uuid = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"
        assertEquals(uuid, speechStartId(mapOf("type" to "speech.start", "id" to uuid)))
        assertEquals("x", speechStartId(mapOf("type" to "speech.start", "id" to "x", "extra" to 1)))
        assertEquals("a".repeat(64), speechStartId(mapOf("type" to "speech.start", "id" to "a".repeat(64))))
    }

    @Test fun wrongTypeIsIgnored() {
        assertNull(speechStartId(mapOf("type" to "speech.result", "id" to "1")))
        assertNull(speechStartId(mapOf("type" to "Speech.Start", "id" to "1")))
        assertNull(speechStartId(mapOf("type" to " speech.start", "id" to "1")))
        assertNull(speechStartId(mapOf("type" to null, "id" to "1")))
        assertNull(speechStartId(mapOf("id" to "1")))
        assertNull(speechStartId(emptyMap()))
    }

    @Test fun badIdIsIgnored() {
        assertNull(speechStartId(mapOf("type" to "speech.start")))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to null)))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to "")))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to 42)))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to true)))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to listOf("1"))))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to "a".repeat(65))))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to "a\nb")))
        assertNull(speechStartId(mapOf("type" to "speech.start", "id" to "a\u0000b")))
    }

    // ---- replies -------------------------------------------------------------------------

    @Test fun bestMatchIsTheResult() {
        assertEquals(
            SpeechReply.Result("7", "remind me at five"),
            speechReplyFor("7", RecognizerOutcome.OK, listOf("remind me at five", "remind me at nine")),
        )
        assertEquals(
            SpeechReply.Result("7", "hello"),
            speechReplyFor("7", RecognizerOutcome.OK, listOf("  hello ")),
        )
    }

    @Test fun emptyResultsAreNoMatch() {
        val noMatch = SpeechReply.Error("7", SpeechError.NO_MATCH)
        assertEquals(noMatch, speechReplyFor("7", RecognizerOutcome.OK, null))
        assertEquals(noMatch, speechReplyFor("7", RecognizerOutcome.OK, emptyList()))
        assertEquals(noMatch, speechReplyFor("7", RecognizerOutcome.OK, listOf(null)))
        assertEquals(noMatch, speechReplyFor("7", RecognizerOutcome.OK, listOf("   ")))
        assertEquals(noMatch, speechReplyFor("7", RecognizerOutcome.NO_MATCH, listOf("ignored")))
    }

    @Test fun otherOutcomes() {
        assertEquals(
            SpeechReply.Error("7", SpeechError.CANCELLED),
            speechReplyFor("7", RecognizerOutcome.CANCELLED, listOf("ignored")),
        )
        assertEquals(
            SpeechReply.Error("7", SpeechError.UNAVAILABLE),
            speechReplyFor("7", RecognizerOutcome.FAILED, null),
        )
    }

    @Test fun replyFieldsMatchTheWireContract() {
        assertEquals(
            listOf("type" to "speech.result", "id" to "7", "text" to "say \"hi\" \\ </script>"),
            SpeechReply.Result("7", "say \"hi\" \\ </script>").fields().toList(),
        )
        assertEquals(
            listOf("type" to "speech.error", "id" to "7", "error" to "cancelled"),
            SpeechReply.Error("7", SpeechError.CANCELLED).fields().toList(),
        )
        assertEquals(
            listOf("cancelled", "no_match", "unavailable", "busy"),
            SpeechError.entries.map { it.wire },
        )
    }
}
