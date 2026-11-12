package dev.vector.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding

/**
 * The app: a full-screen WebView on the saved server origin, plus a native failure screen.
 * Everything the user sees inside the WebView is served by their own Vector server.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var server: Origin
    private lateinit var webContainer: ViewGroup
    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var failure: View
    private lateinit var failureTitle: TextView
    private lateinit var failureBody: TextView
    private lateinit var failureDetail: TextView

    /** Set when the current main-frame load failed; cleared by Retry. */
    private var loadFailed = false
    private var firstPageShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val saved = ServerStore.load(this)
        if (saved == null || intent?.action == ACTION_CHANGE_SERVER) {
            // First run, or the "Change server" launcher shortcut.
            startActivity(SetupActivity.intent(this))
            if (saved == null) {
                finish()
                return
            }
            // Keep this activity underneath so Back from "Change server" returns to the app.
            intent.action = Intent.ACTION_MAIN
        }
        server = saved

        setContentView(R.layout.activity_main)
        webContainer = findViewById(R.id.web_container)
        web = findViewById(R.id.web)
        progress = findViewById(R.id.load_progress)
        failure = findViewById(R.id.failure)
        failureTitle = findViewById(R.id.failure_title)
        failureBody = findViewById(R.id.failure_body)
        failureDetail = findViewById(R.id.failure_detail)

        findViewById<Button>(R.id.retry).setOnClickListener { retry() }
        findViewById<Button>(R.id.change_server).setOnClickListener {
            startActivity(SetupActivity.intent(this))
        }

        applyWindowInsets()
        configureWebView()
        configureBack()

        val state = savedInstanceState?.getBundle(STATE_WEB)
        firstPageShown = savedInstanceState?.getBoolean(STATE_FIRST_PAGE_SHOWN) ?: false
        if (state == null || web.restoreState(state) == null) {
            progress.visibility = View.VISIBLE
            web.loadUrl(server.toString())
        }
    }

    // ---- window insets ------------------------------------------------------------------

    /**
     * The window is always edge to edge. The web client lays itself out with
     * `viewport-fit=cover` and `env(safe-area-inset-*)`, so on a WebView that reports the system
     * bars through those variables the page gets the whole screen and handles the insets itself.
     * Older WebViews only report display cutouts there, so for them the container is padded
     * natively instead (the page then sees zero insets). The keyboard always shrinks the WebView,
     * which is what `adjustResize` means for an edge-to-edge window.
     */
    private fun applyWindowInsets() {
        val pageHandlesInsets = webViewMajorVersion() >= MIN_WEBVIEW_FOR_PAGE_INSETS
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.main_root)) { _, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val keyboardOpen = ime.bottom > 0

            failure.updatePadding(
                left = bars.left,
                top = bars.top,
                right = bars.right,
                bottom = maxOf(bars.bottom, ime.bottom),
            )
            progress.updateLayoutParams<ViewGroup.MarginLayoutParams> { topMargin = bars.top }

            if (pageHandlesInsets) {
                webContainer.updatePadding(left = 0, top = 0, right = 0, bottom = ime.bottom)
                if (keyboardOpen) {
                    // The WebView now ends at the keyboard: tell it there is no bottom inset left.
                    WindowInsetsCompat.Builder(insets)
                        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                        .setInsets(
                            WindowInsetsCompat.Type.navigationBars(),
                            insets.getInsets(WindowInsetsCompat.Type.navigationBars()).withBottom(0),
                        )
                        .build()
                } else {
                    insets
                }
            } else {
                webContainer.updatePadding(
                    left = bars.left,
                    top = bars.top,
                    right = bars.right,
                    bottom = maxOf(bars.bottom, ime.bottom),
                )
                WindowInsetsCompat.CONSUMED
            }
        }
    }

    private fun Insets.withBottom(bottom: Int): Insets = Insets.of(left, top, right, bottom)

    private fun webViewMajorVersion(): Int =
        WebView.getCurrentWebViewPackage()?.versionName
            ?.substringBefore('.')
            ?.toIntOrNull()
            ?: 0

    // ---- WebView ------------------------------------------------------------------------

    @SuppressLint("SetJavaScriptEnabled") // The page is the user's own Vector server; see class doc.
    private fun configureWebView() {
        // Remote debugging only for debug builds.
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mediaPlaybackRequiresUserGesture = true
        }
        // No addJavascriptInterface anywhere: the page gets no bridge into the app.

        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(web, false)
        }

        web.webViewClient = Client()
        web.webChromeClient = Chrome()
    }

    private inner class Client : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!request.isForMainFrame) {
                // Frames are governed by the server's CSP; only non-web schemes are refused here.
                return !isWebUrl(url)
            }
            return when (decideNavigation(server, url)) {
                NavigationDecision.STAY -> false
                NavigationDecision.EXTERNAL -> {
                    openInBrowser(request.url)
                    true
                }
                NavigationDecision.BLOCK -> true
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // shouldOverrideUrlLoading is not consulted for every kind of navigation (form POSTs,
            // for one). This is the backstop: the main frame never commits to another origin.
            if (url != "about:blank" && decideNavigation(server, url) != NavigationDecision.STAY) {
                view.stopLoading()
                view.loadUrl(server.toString())
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            CookieManager.getInstance().flush()
            if (loadFailed) return
            firstPageShown = true
            progress.visibility = View.GONE
            showWeb()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            showFailure(
                title = getString(R.string.load_failed_title),
                body = getString(R.string.load_failed_body, server),
                detail = error.description?.toString(),
            )
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            // A gateway error from a reverse proxy in front of a stopped server lands here.
            if (!request.isForMainFrame || errorResponse.statusCode < 500) return
            showFailure(
                title = getString(R.string.load_failed_title),
                body = getString(R.string.load_failed_body, server),
                detail = getString(R.string.load_failed_http, errorResponse.statusCode),
            )
        }

        @SuppressLint("WebViewClientOnReceivedSslError") // Reviewed: this never calls proceed().
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            // Certificate errors are never bypassed, for any resource.
            handler.cancel()
            if (Origin.of(error.url.orEmpty()) == server) {
                showFailure(
                    title = getString(R.string.load_failed_tls_title),
                    body = getString(R.string.load_failed_tls_body, server),
                    detail = null,
                )
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The renderer crashed or was killed for memory. This WebView is unusable now; throw
            // it away and rebuild the screen instead of letting the whole app die.
            webContainer.removeView(view)
            view.destroy()
            webDestroyed = true
            recreate()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            if (!firstPageShown && !loadFailed) progress.progress = newProgress
        }

        // Camera, microphone and location are not part of this app: deny explicitly.
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onGeolocationPermissionsShowPrompt(
            origin: String,
            callback: GeolocationPermissions.Callback,
        ) = callback.invoke(origin, false, false)
    }

    private fun openInBrowser(uri: Uri) {
        val intent = Intent(Intent.ACTION_VIEW, uri)
            .addCategory(Intent.CATEGORY_BROWSABLE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_SHORT).show()
        }
    }

    // ---- failure screen -----------------------------------------------------------------

    private fun showFailure(title: String, body: String, detail: String?) {
        loadFailed = true
        failureTitle.text = title
        failureBody.text = body
        failureDetail.text = detail.orEmpty()
        failureDetail.visibility = if (detail.isNullOrBlank()) View.GONE else View.VISIBLE
        progress.visibility = View.GONE
        // Hide the WebView so its built-in error page is never what the user sees.
        webContainer.visibility = View.INVISIBLE
        failure.visibility = View.VISIBLE
    }

    private fun showWeb() {
        failure.visibility = View.GONE
        webContainer.visibility = View.VISIBLE
    }

    private fun retry() {
        loadFailed = false
        if (!firstPageShown) {
            progress.progress = 0
            progress.visibility = View.VISIBLE
        }
        val current = web.url
        if (current != null && decideNavigation(server, current) == NavigationDecision.STAY) {
            web.reload()
        } else {
            web.loadUrl(server.toString())
        }
    }

    // ---- back, lifecycle, state ---------------------------------------------------------

    /**
     * Back walks the WebView history first. The web client pushes a history entry for every
     * sheet and lightbox, so this is also what closes those. With no history left, Back leaves.
     */
    private fun configureBack() {
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (!loadFailed && web.canGoBack()) {
                        web.goBack()
                    } else {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            },
        )
    }

    private var webDestroyed = false

    override fun onResume() {
        super.onResume()
        if (::web.isInitialized && !webDestroyed) web.onResume()
    }

    override fun onPause() {
        if (::web.isInitialized && !webDestroyed) web.onPause()
        // Persist the session cookie now: the process can be killed any time after this.
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!::web.isInitialized || webDestroyed) return
        val state = Bundle()
        if (web.saveState(state) != null) outState.putBundle(STATE_WEB, state)
        outState.putBoolean(STATE_FIRST_PAGE_SHOWN, firstPageShown)
    }

    override fun onDestroy() {
        if (::web.isInitialized && !webDestroyed) {
            webContainer.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val ACTION_CHANGE_SERVER = "dev.vector.app.action.CHANGE_SERVER"
        const val STATE_WEB = "web_state"
        const val STATE_FIRST_PAGE_SHOWN = "first_page_shown"

        /**
         * First WebView major version trusted to expose system-bar insets to the page through
         * `env(safe-area-inset-*)`. Below it the app pads the WebView natively.
         */
        const val MIN_WEBVIEW_FOR_PAGE_INSETS = 140
    }
}
