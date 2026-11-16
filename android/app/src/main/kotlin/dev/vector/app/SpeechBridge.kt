package dev.vector.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.speech.RecognizerIntent
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.util.Locale

/**
 * Speech in and out for the page, through `window.VectorNative` (see SpeechProtocol.kt for the
 * wire contract): speech recognition, text to speech ([Speaker]) and a capabilities query.
 *
 * The page cannot use the Web Speech API in a WebView, so it asks the app instead. The app runs
 * the system speech recognizer ([RecognizerIntent.ACTION_RECOGNIZE_SPEECH]) as a separate
 * activity and hands back only the recognised text. The recognizer owns the microphone, so this
 * app needs no RECORD_AUDIO permission.
 *
 * The bridge is an androidx.webkit web message listener, not a JavaScript interface: WebView
 * injects it only into frames whose origin is exactly the saved server origin, and this class
 * additionally checks the origin and that the message comes from the main frame.
 *
 * Construct it while the activity is being created (it registers an activity-result launcher).
 * The owner calls [stopSpeaking] when the activity pauses or the page goes away, [detach] when
 * the WebView or the server origin changes, and [release] on destroy.
 *
 * At most one recognizer request is in flight; any further request is answered `busy`. The
 * in-flight state lives only in this object, so a recreated activity or a restarted process
 * starts clean, and a recognizer result that arrives with no request waiting is dropped.
 */
class SpeechBridge(private val activity: ComponentActivity) {

    private class Pending(val id: String, val reply: JavaScriptReplyProxy)

    private val launcher = activity.registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
        ::onRecognizerResult,
    )

    private var pending: Pending? = null
    private var attachedTo: WebView? = null
    private val speaker = Speaker(activity)

    /**
     * Exposes the bridge to [origin] in [web], replacing any listener installed earlier (for a
     * previous origin). Returns false, with nothing registered, when the device's WebView does
     * not support web message listeners; the page then has no `VectorNative` and hides its mic.
     */
    fun attach(web: WebView, origin: Origin): Boolean {
        detach()
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return false
        val listener = WebViewCompat.WebMessageListener { _, message, sourceOrigin, isMainFrame, reply ->
            onMessage(origin, message, sourceOrigin, isMainFrame, reply)
        }
        return try {
            WebViewCompat.addWebMessageListener(web, SPEECH_BRIDGE_NAME, setOf(origin.toString()), listener)
            attachedTo = web
            true
        } catch (_: IllegalArgumentException) {
            // WebView rejected the origin rule; expose nothing rather than something wider.
            false
        }
    }

    /** Stops any text to speech (the utterance is answered `tts.done`) and releases audio focus. */
    fun stopSpeaking() = speaker.stop()

    /** [detach], and shuts the text-to-speech engine down. */
    fun release() {
        detach()
        speaker.shutdown()
    }

    /**
     * Removes the bridge, stops speaking, and answers a recognizer request still in flight with
     * `cancelled`.
     */
    fun detach() {
        speaker.stop()
        val web = attachedTo
        attachedTo = null
        if (web != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(web, SPEECH_BRIDGE_NAME)
        }
        pending?.let { send(it.reply, SpeechReply.Error(it.id, SpeechError.CANCELLED)) }
        pending = null
    }

    // Runs on the UI thread.
    private fun onMessage(
        origin: Origin,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        reply: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame) return
        // WebView already enforces the origin rule; this is a second, independent check.
        if (Origin.of(sourceOrigin.toString()) != origin) return
        if (message.type != WebMessageCompat.TYPE_STRING) return
        val raw = message.data ?: return
        // The per-type caps are applied by parseBridgeRequest; this is the outer bound.
        if (raw.length > MAX_TTS_MESSAGE_CHARS) return
        val fields = decodeObject(raw) ?: return
        when (val request = parseBridgeRequest(fields, raw.length) ?: return) {
            is BridgeRequest.SpeechStart -> startRecognizer(request.id, reply)
            is BridgeRequest.Capabilities -> capabilities(request.id, reply)
            is BridgeRequest.TtsSpeak -> speaker.speak(
                id = request.id,
                text = request.text,
                canSpeak = ::isResumed,
                reply = { send(reply, it) },
            )
            BridgeRequest.TtsStop -> speaker.stop()
        }
    }

    private fun isResumed() = activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    private fun recognizerIntent(): Intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        .putExtra(RecognizerIntent.EXTRA_PROMPT, activity.getString(R.string.speech_prompt))
        .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)

    /**
     * `speech`: a recognizer activity resolves (needs the `<queries>` entry on Android 11+).
     * `tts`: an engine initialised; answered once it has, or has failed or timed out.
     */
    private fun capabilities(id: String, reply: JavaScriptReplyProxy) {
        val speech = recognizerIntent().resolveActivity(activity.packageManager) != null
        speaker.whenReady { tts -> send(reply, CapabilitiesReply(id, speech = speech, tts = tts)) }
    }

    private fun startRecognizer(id: String, reply: JavaScriptReplyProxy) {
        if (pending != null) {
            send(reply, SpeechReply.Error(id, SpeechError.BUSY))
            return
        }
        // Only start the recognizer on top of a visible, focused app.
        if (!isResumed()) {
            send(reply, SpeechReply.Error(id, SpeechError.CANCELLED))
            return
        }
        // The app must not talk over the user.
        speaker.stop()
        pending = Pending(id, reply)
        try {
            launcher.launch(recognizerIntent())
        } catch (_: ActivityNotFoundException) {
            pending = null
            send(reply, SpeechReply.Error(id, SpeechError.UNAVAILABLE))
        } catch (_: SecurityException) {
            pending = null
            send(reply, SpeechReply.Error(id, SpeechError.UNAVAILABLE))
        }
    }

    private fun onRecognizerResult(result: ActivityResult) {
        // Null after the activity was recreated or the process restarted: nobody is waiting.
        val request = pending ?: return
        pending = null
        val outcome = when (result.resultCode) {
            Activity.RESULT_OK -> RecognizerOutcome.OK
            Activity.RESULT_CANCELED -> RecognizerOutcome.CANCELLED
            RecognizerIntent.RESULT_NO_MATCH -> RecognizerOutcome.NO_MATCH
            else -> RecognizerOutcome.FAILED // client, server, network or audio error
        }
        val matches = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        send(request.reply, speechReplyFor(request.id, outcome, matches))
    }

    private fun send(reply: JavaScriptReplyProxy, message: BridgeReply) {
        // Always true when a reply proxy exists; checked so the call is visibly guarded.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        try {
            reply.postMessage(JSONObject(message.fields()).toString())
        } catch (_: IllegalStateException) {
            // The page or WebView that asked is gone; there is nobody left to answer.
        }
    }

    /** Top-level members of a JSON object (JSON null as null), or null if [raw] is not one. */
    private fun decodeObject(raw: String): Map<String, Any?>? = try {
        val tokener = JSONTokener(raw)
        val obj = tokener.nextValue() as? JSONObject
        // Reject trailing content after the object.
        if (obj == null || tokener.nextClean() != '\u0000') {
            null
        } else {
            obj.keys().asSequence().associateWith { key -> obj.opt(key).takeUnless { it == JSONObject.NULL } }
        }
    } catch (_: JSONException) {
        null
    }
}
