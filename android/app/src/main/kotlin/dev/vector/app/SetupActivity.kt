package dev.vector.app

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * First-run screen (and "Change server"): asks for the server address, checks that a Vector
 * server answers there, saves the origin and opens the WebView.
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var address: EditText
    private lateinit var warning: TextView
    private lateinit var error: TextView
    private lateinit var connect: Button
    private lateinit var progress: ProgressBar

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()

    /** Bumped for every probe so a slow, superseded answer is ignored. */
    private var attempt = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        address = findViewById(R.id.address)
        warning = findViewById(R.id.cleartext_warning)
        error = findViewById(R.id.setup_error)
        connect = findViewById(R.id.connect)
        progress = findViewById(R.id.setup_progress)

        // Edge to edge: keep the form clear of the system bars, the cutout and the keyboard.
        val root = findViewById<View>(R.id.setup_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safe = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            view.updatePadding(left = safe.left, top = safe.top, right = safe.right, bottom = safe.bottom)
            WindowInsetsCompat.CONSUMED
        }

        address.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                updateCleartextWarning()
                error.visibility = View.GONE
            }
        })
        address.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                onConnect()
                true
            } else {
                false
            }
        }
        connect.setOnClickListener { onConnect() }

        if (savedInstanceState == null) {
            // "Change server": start from the current address.
            ServerStore.load(this)?.let { address.setText(it.toString()) }
        }
        updateCleartextWarning()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun updateCleartextWarning() {
        val result = normalizeServerAddress(address.text.toString())
        val cleartext = result is AddressResult.Ok && result.origin.isCleartext
        warning.visibility = if (cleartext) View.VISIBLE else View.GONE
    }

    private fun onConnect() {
        val origin = when (val result = normalizeServerAddress(address.text.toString())) {
            is AddressResult.Ok -> result.origin
            is AddressResult.Invalid -> {
                showError(
                    getString(
                        when (result.reason) {
                            AddressResult.Reason.EMPTY -> R.string.error_address_empty
                            AddressResult.Reason.UNSUPPORTED_SCHEME -> R.string.error_address_scheme
                            AddressResult.Reason.HAS_CREDENTIALS -> R.string.error_address_credentials
                            AddressResult.Reason.MALFORMED -> R.string.error_address_malformed
                        },
                    ),
                )
                return
            }
        }

        setBusy(true)
        error.visibility = View.GONE
        val thisAttempt = ++attempt
        executor.execute {
            val result = ServerProbe.probe(origin)
            runOnUiThread {
                if (thisAttempt == attempt && !isFinishing && !isDestroyed) onProbed(origin, result)
            }
        }
    }

    private fun onProbed(origin: Origin, result: ProbeResult) {
        setBusy(false)
        when (result) {
            ProbeResult.Ok -> {
                ServerStore.save(this, origin)
                startActivity(
                    Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                )
                finish()
            }
            ProbeResult.NotVector -> showError(getString(R.string.error_not_vector, origin))
            is ProbeResult.Redirects -> {
                address.setText(result.to.toString())
                address.setSelection(address.text.length)
                showError(getString(R.string.error_redirect, result.to))
            }
            is ProbeResult.TlsFailure -> showError(getString(R.string.error_tls, origin), result.detail)
            is ProbeResult.Unreachable -> showError(getString(R.string.error_unreachable, origin), result.detail)
        }
    }

    private fun showError(message: String, detail: String? = null) {
        error.text = if (detail.isNullOrBlank()) {
            message
        } else {
            message + "\n\n" + getString(R.string.error_detail, detail)
        }
        error.visibility = View.VISIBLE
    }

    private fun setBusy(busy: Boolean) {
        connect.isEnabled = !busy
        address.isEnabled = !busy
        connect.setText(if (busy) R.string.setup_connecting else R.string.setup_connect)
        progress.visibility = if (busy) View.VISIBLE else View.INVISIBLE
    }

    companion object {
        fun intent(context: Context): Intent = Intent(context, SetupActivity::class.java)
    }
}
