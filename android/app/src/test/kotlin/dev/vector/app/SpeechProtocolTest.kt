package dev.vector.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechProtocolTest {

    private fun parse(vararg fields: Pair<String, Any?>, rawLength: Int = 64) =
        parseBridgeRequest(mapOf(*fields), rawLength)

    // ---- speech.start --------------------------------------------------------------------

    @Test fun validStartIsAccepted() {
        assertEquals(BridgeRequest.SpeechStart("abc-1"), parse("type" to "speech.start", "id" to "abc-1"))
        val uuid = "speech-12-3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b"
        assertEquals(BridgeRequest.SpeechStart(uuid), parse("type" to "speech.start", "id" to uuid))
        assertEquals(BridgeRequest.SpeechStart("x"), parse("type" to "speech.start", "id" to "x", "extra" to 1))
        val longest = "a".repeat(64)
        assertEquals(BridgeRequest.SpeechStart(longest), parse("type" to "speech.start", "id" to longest))
    }

    @Test fun wrongTypeIsIgnored() {
        assertNull(parse("type" to "speech.result", "id" to "1"))
        assertNull(parse("type" to "Speech.Start", "id" to "1"))
        assertNull(parse("type" to " speech.start", "id" to "1"))
        assertNull(parse("type" to "tts.done", "id" to "1"))
        assertNull(parse("type" to null, "id" to "1"))
        assertNull(parse("type" to 3, "id" to "1"))
        assertNull(parse("id" to "1"))
        assertNull(parse())
    }

    @Test fun badIdIsIgnored() {
        for (id in listOf(null, "", 42, true, listOf("1"), "a".repeat(65), "a\nb", "a\u0000b")) {
            assertNull("$id", parse("type" to "speech.start", "id" to id))
            assertNull("$id", parse("type" to "capabilities", "id" to id))
            assertNull("$id", parse("type" to "tts.speak", "id" to id, "text" to "hi"))
        }
        assertNull(parse("type" to "speech.start"))
    }

    // ---- capabilities, tts.speak, tts.stop -----------------------------------------------

    @Test fun capabilitiesAndStop() {
        assertEquals(BridgeRequest.Capabilities("c1"), parse("type" to "capabilities", "id" to "c1"))
        assertEquals(BridgeRequest.TtsStop, parse("type" to "tts.stop"))
        assertEquals(BridgeRequest.TtsStop, parse("type" to "tts.stop", "id" to "ignored"))
    }

    @Test fun ttsSpeakIsAccepted() {
        assertEquals(
            BridgeRequest.TtsSpeak("t1", "Hello there."),
            parse("type" to "tts.speak", "id" to "t1", "text" to "Hello there."),
        )
        assertEquals(BridgeRequest.TtsSpeak("t1", ""), parse("type" to "tts.speak", "id" to "t1", "text" to ""))
        val longest = "a".repeat(4000)
        assertEquals(
            BridgeRequest.TtsSpeak("t1", longest),
            parse("type" to "tts.speak", "id" to "t1", "text" to longest, rawLength = 4040),
        )
    }

    @Test fun badTtsSpeakIsIgnored() {
        assertNull(parse("type" to "tts.speak", "id" to "t1"))
        assertNull(parse("type" to "tts.speak", "id" to "t1", "text" to null))
        assertNull(parse("type" to "tts.speak", "id" to "t1", "text" to 5))
        assertNull(parse("type" to "tts.speak", "id" to "t1", "text" to "a".repeat(4001), rawLength = 4041))
    }

    @Test fun sizeCapsDependOnType() {
        // tts.speak may be large; everything else keeps the small cap.
        assertEquals(
            BridgeRequest.TtsSpeak("t1", "hi"),
            parse("type" to "tts.speak", "id" to "t1", "text" to "hi", rawLength = MAX_TTS_MESSAGE_CHARS),
        )
        assertNull(parse("type" to "tts.speak", "id" to "t1", "text" to "hi", rawLength = MAX_TTS_MESSAGE_CHARS + 1))
        for (type in listOf("speech.start", "capabilities", "tts.stop")) {
            assertTrue(type, parse("type" to type, "id" to "1", rawLength = MAX_SPEECH_MESSAGE_CHARS) != null)
            assertNull(type, parse("type" to type, "id" to "1", rawLength = MAX_SPEECH_MESSAGE_CHARS + 1))
        }
        // The raw cap fits the longest text even if every character arrives escaped as \uXXXX.
        assertTrue(MAX_TTS_TEXT_CHARS * 6 + MAX_SPEECH_ID_CHARS * 6 + 64 <= MAX_TTS_MESSAGE_CHARS)
    }

    // ---- replies -------------------------------------------------------------------------

    @Test fun bestMatchIsTheResult() {
        assertEquals(
            SpeechReply.Result("7", "remind me at five"),
            speechReplyFor("7", RecognizerOutcome.OK, listOf("remind me at five", "remind me at nine")),
        )
        assertEquals(SpeechReply.Result("7", "hello"), speechReplyFor("7", RecognizerOutcome.OK, listOf("  hello ")))
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
        assertEquals(SpeechReply.Error("7", SpeechError.UNAVAILABLE), speechReplyFor("7", RecognizerOutcome.FAILED, null))
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
        assertEquals(listOf("cancelled", "no_match", "unavailable", "busy"), SpeechError.entries.map { it.wire })
        assertEquals(
            listOf("type" to "capabilities", "id" to "c", "speech" to true, "tts" to false),
            CapabilitiesReply("c", speech = true, tts = false).fields().toList(),
        )
        assertEquals(listOf("type" to "tts.done", "id" to "t"), TtsReply.Done("t").fields().toList())
        assertEquals(
            listOf("type" to "tts.error", "id" to "t", "error" to "busy"),
            TtsReply.Error("t", TtsError.BUSY).fields().toList(),
        )
        assertEquals(listOf("unavailable", "busy"), TtsError.entries.map { it.wire })
    }

    // ---- chunking ------------------------------------------------------------------------

    @Test fun shortTextIsOnePiece() {
        assertEquals(listOf("Hello. How are you?"), chunkForSpeech("  Hello. How are you?\n", 100))
        assertEquals(emptyList<String>(), chunkForSpeech("", 100))
        assertEquals(emptyList<String>(), chunkForSpeech(" \n\t ", 100))
    }

    @Test fun longTextIsCutAtSentencesAndPacked() {
        val text = "One two three. Four five six! Seven eight nine? Ten."
        assertEquals(
            listOf("One two three.", "Four five six!", "Seven eight nine? Ten."),
            chunkForSpeech(text, 22),
        )
        assertEquals(listOf("One two three. Four five six!", "Seven eight nine? Ten."), chunkForSpeech(text, 30))
    }

    @Test fun lineBreaksEndSentences() {
        assertEquals(listOf("First line", "second line"), chunkForSpeech("First line\nsecond line", 12))
        assertEquals(listOf("Item one", "item two"), chunkForSpeech("Item one\n\n  item two", 10))
    }

    @Test fun overlongSentencesAreCutAtSpacesOrHard() {
        assertEquals(listOf("aaaa bbbb", "cccc dddd", "ee"), chunkForSpeech("aaaa bbbb cccc dddd ee", 10))
        assertEquals(listOf("abcdefgh", "ijklmnop", "qr"), chunkForSpeech("abcdefghijklmnopqr", 8))
        // Never split a surrogate pair (an emoji here).
        val emoji = "😀"
        val pieces = chunkForSpeech("abc$emoji" + "defg", 4)
        assertEquals(listOf("abc", emoji + "de", "fg"), pieces)
    }

    @Test fun piecesRespectTheLimitAndKeepEveryWord() {
        val words = (1..400).joinToString(" ") { if (it % 9 == 0) "word$it." else "word$it" }
        for (max in listOf(15, 40, 120, 1000)) {
            val pieces = chunkForSpeech(words, max)
            assertTrue(pieces.all { it.isNotBlank() && it.length <= max })
            assertEquals(words.split(' '), pieces.joinToString(" ").split(' '))
        }
    }
}
