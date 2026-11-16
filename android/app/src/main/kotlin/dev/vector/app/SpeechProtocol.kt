package dev.vector.app

/**
 * Pure logic of the `VectorNative` speech bridge: no Android classes and no org.json, so it runs
 * in plain JVM unit tests. MainActivity decodes and encodes the JSON with org.json and asks this
 * file what a message means and what to answer.
 *
 * Wire contract (strings in both directions):
 *  - page → app: `{"type":"speech.start","id":"<unique>"}`
 *  - app → page: `{"type":"speech.result","id":"<same id>","text":"<best result>"}` or
 *    `{"type":"speech.error","id":"<same id>","error":"cancelled"|"no_match"|"unavailable"|"busy"}`
 *
 * Messages that do not match are ignored: there is no reply that could tell the page anything
 * about a request whose id cannot be trusted.
 */

/** Name of the object the page sees on `window`. */
const val SPEECH_BRIDGE_NAME = "VectorNative"

/** Longer raw messages are dropped before they are parsed. */
const val MAX_SPEECH_MESSAGE_CHARS = 1_024

/** Longest accepted request id. */
const val MAX_SPEECH_ID_CHARS = 64

const val SPEECH_START = "speech.start"
const val SPEECH_RESULT = "speech.result"
const val SPEECH_ERROR = "speech.error"

/** The error codes the page understands. */
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

/** How the system recognizer activity ended, mapped from its result code by the caller. */
enum class RecognizerOutcome { OK, CANCELLED, NO_MATCH, FAILED }

sealed interface SpeechReply {
    val id: String

    data class Result(override val id: String, val text: String) : SpeechReply
    data class Error(override val id: String, val error: SpeechError) : SpeechReply

    /** The reply as flat JSON fields, in wire order. The caller serialises them with org.json. */
    fun fields(): Map<String, String> = when (this) {
        is Result -> linkedMapOf("type" to SPEECH_RESULT, "id" to id, "text" to text)
        is Error -> linkedMapOf("type" to SPEECH_ERROR, "id" to id, "error" to error.wire)
    }
}

/**
 * The id of a valid `speech.start` request, or null when the message must be ignored.
 *
 * [fields] are the top-level members of the decoded JSON object (JSON null as Kotlin null).
 * `type` must be exactly `speech.start`; `id` must be a string of 1 to [MAX_SPEECH_ID_CHARS]
 * characters without control characters. Unknown extra members are tolerated.
 */
fun speechStartId(fields: Map<String, Any?>): String? {
    if (fields["type"] != SPEECH_START) return null
    val id = fields["id"] as? String ?: return null
    if (id.isEmpty() || id.length > MAX_SPEECH_ID_CHARS) return null
    if (id.any { it.isISOControl() }) return null
    return id
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
