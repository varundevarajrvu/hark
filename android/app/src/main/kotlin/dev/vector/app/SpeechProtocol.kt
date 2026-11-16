package dev.vector.app

/**
 * Pure logic of the `VectorNative` bridge: no Android classes and no org.json, so it runs in
 * plain JVM unit tests. SpeechBridge decodes and encodes the JSON with org.json and asks this
 * file what a message means and what to answer.
 *
 * Wire contract (JSON strings in both directions):
 *
 * Speech recognition
 *  - page → app: `{"type":"speech.start","id":"<id>"}`
 *  - app → page: `{"type":"speech.result","id":"<id>","text":"<best result>"}` or
 *    `{"type":"speech.error","id":"<id>","error":"cancelled"|"no_match"|"unavailable"|"busy"}`
 *
 * Capabilities
 *  - page → app: `{"type":"capabilities","id":"<id>"}`
 *  - app → page: `{"type":"capabilities","id":"<id>","speech":true|false,"tts":true|false}`
 *
 * Text to speech
 *  - page → app: `{"type":"tts.speak","id":"<id>","text":"<up to 4000 chars>"}`
 *  - page → app: `{"type":"tts.stop"}`
 *  - app → page: `{"type":"tts.done","id":"<id>"}` (finished, stopped or replaced) or
 *    `{"type":"tts.error","id":"<id>","error":"unavailable"|"busy"}`
 *
 * Messages that do not match are ignored: there is no reply that could tell the page anything
 * about a request whose id cannot be trusted.
 */

/** Name of the object the page sees on `window`. */
const val SPEECH_BRIDGE_NAME = "VectorNative"

/** Raw size cap for every message except `tts.speak`. */
const val MAX_SPEECH_MESSAGE_CHARS = 1_024

/** Longest `tts.speak` text, in UTF-16 units (the same unit as JavaScript's `length`). */
const val MAX_TTS_TEXT_CHARS = 4_000

/**
 * Raw size cap for `tts.speak`: room for [MAX_TTS_TEXT_CHARS] even if every character arrives
 * as a six-character `\uXXXX` escape, plus an escaped id and the envelope. Larger messages are
 * dropped before they are parsed.
 */
const val MAX_TTS_MESSAGE_CHARS = 24_576

/** Longest accepted request id. */
const val MAX_SPEECH_ID_CHARS = 64

const val SPEECH_START = "speech.start"
const val SPEECH_RESULT = "speech.result"
const val SPEECH_ERROR = "speech.error"
const val CAPABILITIES = "capabilities"
const val TTS_SPEAK = "tts.speak"
const val TTS_STOP = "tts.stop"
const val TTS_DONE = "tts.done"
const val TTS_ERROR = "tts.error"

// ---- requests -------------------------------------------------------------------------------

sealed interface BridgeRequest {
    data class SpeechStart(val id: String) : BridgeRequest
    data class Capabilities(val id: String) : BridgeRequest
    data class TtsSpeak(val id: String, val text: String) : BridgeRequest
    data object TtsStop : BridgeRequest
}

/**
 * The request a message carries, or null when it must be ignored.
 *
 * [fields] are the top-level members of the decoded JSON object (JSON null as Kotlin null);
 * [rawLength] is the length of the undecoded message. Only `tts.speak` may be longer than
 * [MAX_SPEECH_MESSAGE_CHARS] (up to [MAX_TTS_MESSAGE_CHARS]). Ids must be strings of 1 to
 * [MAX_SPEECH_ID_CHARS] characters without control characters; `tts.speak` text must be a
 * string of at most [MAX_TTS_TEXT_CHARS] characters. Unknown extra members are tolerated.
 */
fun parseBridgeRequest(fields: Map<String, Any?>, rawLength: Int): BridgeRequest? {
    val type = fields["type"] as? String ?: return null
    if (rawLength > MAX_TTS_MESSAGE_CHARS) return null
    if (type != TTS_SPEAK && rawLength > MAX_SPEECH_MESSAGE_CHARS) return null
    return when (type) {
        SPEECH_START -> validId(fields["id"])?.let { BridgeRequest.SpeechStart(it) }
        CAPABILITIES -> validId(fields["id"])?.let { BridgeRequest.Capabilities(it) }
        TTS_SPEAK -> {
            val id = validId(fields["id"]) ?: return null
            val text = fields["text"] as? String ?: return null
            if (text.length > MAX_TTS_TEXT_CHARS) return null
            BridgeRequest.TtsSpeak(id, text)
        }
        TTS_STOP -> BridgeRequest.TtsStop
        else -> null
    }
}

private fun validId(value: Any?): String? {
    val id = value as? String ?: return null
    if (id.isEmpty() || id.length > MAX_SPEECH_ID_CHARS) return null
    if (id.any { it.isISOControl() }) return null
    return id
}

// ---- replies --------------------------------------------------------------------------------

/** Any reply to the page, as flat JSON fields in wire order; serialised with org.json. */
sealed interface BridgeReply {
    fun fields(): Map<String, Any>
}

/** The error codes of `speech.error`. */
enum class SpeechError(val wire: String) {
    /** The user backed out of the recognizer (or the request was abandoned). */
    CANCELLED("cancelled"),

    /** The recognizer finished without any text. */
    NO_MATCH("no_match"),

    /** Nothing on the device can recognise speech, or the recognizer failed. */
    UNAVAILABLE("unavailable"),

    /** Another request is still in flight. */
    BUSY("busy"),
}

/** The error codes of `tts.error`. */
enum class TtsError(val wire: String) {
    /** No text-to-speech engine, it failed to start, or it failed on this text. */
    UNAVAILABLE("unavailable"),

    /** Speaking is not possible right now: the app is not in the foreground or audio focus was refused (a call). */
    BUSY("busy"),
}

/** How the system recognizer activity ended, mapped from its result code by the caller. */
enum class RecognizerOutcome { OK, CANCELLED, NO_MATCH, FAILED }

sealed interface SpeechReply : BridgeReply {
    val id: String

    data class Result(override val id: String, val text: String) : SpeechReply
    data class Error(override val id: String, val error: SpeechError) : SpeechReply

    override fun fields(): Map<String, Any> = when (this) {
        is Result -> linkedMapOf("type" to SPEECH_RESULT, "id" to id, "text" to text)
        is Error -> linkedMapOf("type" to SPEECH_ERROR, "id" to id, "error" to error.wire)
    }
}

data class CapabilitiesReply(val id: String, val speech: Boolean, val tts: Boolean) : BridgeReply {
    override fun fields(): Map<String, Any> =
        linkedMapOf("type" to CAPABILITIES, "id" to id, "speech" to speech, "tts" to tts)
}

sealed interface TtsReply : BridgeReply {
    val id: String

    data class Done(override val id: String) : TtsReply
    data class Error(override val id: String, val error: TtsError) : TtsReply

    override fun fields(): Map<String, Any> = when (this) {
        is Done -> linkedMapOf("type" to TTS_DONE, "id" to id)
        is Error -> linkedMapOf("type" to TTS_ERROR, "id" to id, "error" to error.wire)
    }
}

/**
 * The reply to a finished recognizer run. [matches] is `RecognizerIntent.EXTRA_RESULTS`, best
 * first; an empty list or an empty best match counts as no match.
 */
fun speechReplyFor(id: String, outcome: RecognizerOutcome, matches: List<String?>?): SpeechReply =
    when (outcome) {
        RecognizerOutcome.CANCELLED -> SpeechReply.Error(id, SpeechError.CANCELLED)
        RecognizerOutcome.NO_MATCH -> SpeechReply.Error(id, SpeechError.NO_MATCH)
        RecognizerOutcome.FAILED -> SpeechReply.Error(id, SpeechError.UNAVAILABLE)
        RecognizerOutcome.OK -> {
            val best = matches?.firstOrNull()?.trim()
            if (best.isNullOrEmpty()) {
                SpeechReply.Error(id, SpeechError.NO_MATCH)
            } else {
                SpeechReply.Result(id, best)
            }
        }
    }

// ---- text-to-speech chunking ----------------------------------------------------------------

/** End of a sentence: terminal punctuation (plus closing quotes/brackets) and then whitespace, or a line break. */
private val SENTENCE_END = Regex("""(?<=[.!?…。！？][)\]"'”’»]?)\s+|\s*\n\s*""")

/**
 * Splits [text] into pieces of at most [maxChars] characters for `TextToSpeech.speak`, to be
 * queued in order. Text that fits is spoken as one piece. Longer text is cut at sentence ends
 * and the sentences are packed greedily into pieces; a single sentence longer than [maxChars] is
 * cut at the last space before the limit, or hard at the limit when there is none (never inside
 * a surrogate pair). Blank text gives no pieces.
 */
fun chunkForSpeech(text: String, maxChars: Int): List<String> {
    require(maxChars >= 2) { "maxChars too small: $maxChars" }
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return emptyList()
    if (trimmed.length <= maxChars) return listOf(trimmed)

    val pieces = mutableListOf<String>()
    val current = StringBuilder()
    fun flush() {
        if (current.isNotBlank()) pieces += current.toString().trim()
        current.setLength(0)
    }
    for (sentence in trimmed.split(SENTENCE_END).filter { it.isNotBlank() }) {
        for (part in splitLongSentence(sentence, maxChars)) {
            val joined = if (current.isEmpty()) part.length else current.length + 1 + part.length
            if (joined > maxChars) flush()
            if (current.isNotEmpty()) current.append(' ')
            current.append(part)
        }
    }
    flush()
    return pieces
}

private fun splitLongSentence(sentence: String, maxChars: Int): List<String> {
    val parts = mutableListOf<String>()
    var rest = sentence.trim()
    while (rest.length > maxChars) {
        val space = rest.lastIndexOf(' ', maxChars)
        var cut = if (space > 0) space else maxChars
        if (space <= 0 && Character.isHighSurrogate(rest[cut - 1])) cut -= 1
        parts += rest.substring(0, cut).trim()
        rest = rest.substring(cut).trim()
    }
    if (rest.isNotEmpty()) parts += rest
    return parts
}
