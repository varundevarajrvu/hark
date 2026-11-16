package dev.vector.app

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Speaks text with the phone's own text-to-speech engine, for the page's `tts.speak`.
 *
 * Everything here runs on the main thread; engine callbacks are posted back to it. The engine is
 * created lazily on first use and answers [whenReady] once it has initialised, failed, or not
 * answered within [INIT_TIMEOUT_MS]. A failed engine is retried on the next request.
 *
 * At most one utterance is current. A new [speak] replaces it (QUEUE_FLUSH) and the replaced one
 * is answered done; [stop] answers the current one done. While speaking, the app holds transient
 * audio focus (other audio ducks) and gives it back when the utterance ends in any way; losing
 * focus (a call, another app taking audio) stops speaking.
 */
class Speaker(context: Context) {

    private class Utterance(val generation: Int, val id: String, val reply: (TtsReply) -> Unit) {
        var lastPiece = -1
    }

    private enum class EngineState { NONE, STARTING, READY }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val audio = appContext.getSystemService(AudioManager::class.java)

    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    private val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
        .setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener({ change ->
            if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) stop()
        }, main)
        .build()

    private var engine: TextToSpeech? = null
    private var engineState = EngineState.NONE

    /** Bumped for every engine instance so callbacks from an abandoned one are ignored. */
    private var engineGeneration = 0
    private val waiters = mutableListOf<(Boolean) -> Unit>()
    private val initTimeout = Runnable { finishInit(engineGeneration, ok = false) }

    private var current: Utterance? = null
    private var utteranceGeneration = 0
    private var holdingFocus = false

    /** Calls [callback] with whether an engine is ready, starting one if needed. */
    fun whenReady(callback: (Boolean) -> Unit) {
        when (engineState) {
            EngineState.READY -> callback(true)
            EngineState.STARTING -> waiters += callback
            EngineState.NONE -> {
                waiters += callback
                startEngine()
            }
        }
    }

    private fun startEngine() {
        engineState = EngineState.STARTING
        val generation = ++engineGeneration
        // onInit can run inside the constructor (no engine installed), so always hop through the
        // handler: by then `engine` is assigned.
        engine = TextToSpeech(appContext) { status ->
            main.post { finishInit(generation, status == TextToSpeech.SUCCESS) }
        }
        main.postDelayed(initTimeout, INIT_TIMEOUT_MS)
    }

    private fun finishInit(generation: Int, ok: Boolean) {
        if (generation != engineGeneration || engineState != EngineState.STARTING) return
        main.removeCallbacks(initTimeout)
        val tts = engine
        val ready = ok && tts != null && configure(tts)
        if (ready) {
            engineState = EngineState.READY
        } else {
            releaseEngine()
        }
        val callbacks = waiters.toList()
        waiters.clear()
        callbacks.forEach { it(ready) }
    }

    /** Language, audio attributes and progress callbacks. False if the engine is unusable. */
    private fun configure(tts: TextToSpeech): Boolean {
        val language = tts.setLanguage(Locale.getDefault())
        if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
            // Fall back to the engine's own default voice.
            val fallback = tts.defaultVoice ?: return false
            if (tts.setVoice(fallback) != TextToSpeech.SUCCESS) return false
        }
        tts.setAudioAttributes(attributes)
        tts.setOnUtteranceProgressListener(Progress())
        return true
    }

    private fun releaseEngine() {
        main.removeCallbacks(initTimeout)
        engine?.shutdown()
        engine = null
        engineState = EngineState.NONE
        engineGeneration++
    }

    // ---- speaking -------------------------------------------------------------------------

    /**
     * Speaks [text] for request [id], replacing whatever is current; [reply] gets exactly one
     * answer for it. [canSpeak] is asked once the engine is ready (that may have taken a while);
     * when it says no, the request is answered `busy`.
     */
    fun speak(id: String, text: String, canSpeak: () -> Boolean, reply: (TtsReply) -> Unit) {
        endCurrent()
        val utterance = Utterance(++utteranceGeneration, id, reply)
        current = utterance
        whenReady { ready ->
            // Replaced or stopped while the engine was starting: already answered.
            if (current !== utterance) return@whenReady
            val tts = engine
            when {
                !ready || tts == null -> fail(utterance, TtsError.UNAVAILABLE)
                !canSpeak() -> fail(utterance, TtsError.BUSY)
                else -> start(tts, utterance, text)
            }
        }
    }

    private fun start(tts: TextToSpeech, utterance: Utterance, text: String) {
        val pieces = chunkForSpeech(text, TextToSpeech.getMaxSpeechInputLength().coerceAtLeast(2))
        if (pieces.isEmpty()) {
            current = null
            quiet()
            utterance.reply(TtsReply.Done(utterance.id))
            return
        }
        if (!holdingFocus) {
            if (audio.requestAudioFocus(focusRequest) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                fail(utterance, TtsError.BUSY)
                return
            }
            holdingFocus = true
        }
        utterance.lastPiece = pieces.lastIndex
        for ((index, piece) in pieces.withIndex()) {
            val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val queued = tts.speak(piece, mode, null, "${utterance.generation}:$index")
            if (queued != TextToSpeech.SUCCESS) {
                fail(utterance, TtsError.UNAVAILABLE)
                return
            }
        }
    }

    /** Stops speaking; the current utterance, if any, is answered done. */
    fun stop() {
        endCurrent()
        quiet()
    }

    /** Stops speaking and shuts the engine down. The next request starts a new one. */
    fun shutdown() {
        stop()
        val callbacks = waiters.toList()
        waiters.clear()
        releaseEngine()
        callbacks.forEach { it(false) }
    }

    /** Answers the current utterance done, without touching the engine or audio focus. */
    private fun endCurrent() {
        val utterance = current ?: return
        current = null
        utterance.reply(TtsReply.Done(utterance.id))
    }

    private fun fail(utterance: Utterance, error: TtsError) {
        if (current === utterance) current = null
        quiet()
        utterance.reply(TtsReply.Error(utterance.id, error))
    }

    /** Silences the engine and gives audio focus back. */
    private fun quiet() {
        if (engineState == EngineState.READY) engine?.stop()
        if (holdingFocus) {
            audio.abandonAudioFocusRequest(focusRequest)
            holdingFocus = false
        }
    }

    private fun onPieceDone(utteranceId: String?, failed: Boolean) {
        val utterance = current ?: return
        val generation = utteranceId?.substringBefore(':')?.toIntOrNull() ?: return
        val index = utteranceId.substringAfter(':').toIntOrNull() ?: return
        if (generation != utterance.generation) return
        if (failed) {
            fail(utterance, TtsError.UNAVAILABLE)
        } else if (index == utterance.lastPiece) {
            current = null
            quiet()
            utterance.reply(TtsReply.Done(utterance.id))
        }
    }

    /** Engine callbacks arrive on a binder thread; handle them on the main thread. */
    private inner class Progress : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) = Unit

        override fun onDone(utteranceId: String?) {
            main.post { onPieceDone(utteranceId, failed = false) }
        }

        @Deprecated("Deprecated in the platform API; onError(String, Int) is the one called.")
        override fun onError(utteranceId: String?) {
            main.post { onPieceDone(utteranceId, failed = true) }
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            main.post { onPieceDone(utteranceId, failed = true) }
        }

        // Stopped or flushed: only ever by this class, which has already answered.
        override fun onStop(utteranceId: String?, interrupted: Boolean) = Unit
    }

    private companion object {
        const val INIT_TIMEOUT_MS = 8_000L
    }
}
