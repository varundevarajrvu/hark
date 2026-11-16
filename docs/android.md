# Vector for Android

The Android app is a thin native shell around your own Vector server. On first run it asks for
the server's address, checks that a Vector server answers there, and from then on shows that
server's web client full screen. Nothing is bundled from the web client and nothing is sent
anywhere except to the address you entered.

## 1. Make the server reachable from the phone

By default the server listens on `127.0.0.1:8787`, which a phone cannot reach.

### At home, over Wi-Fi

```sh
npm run build
HOST=0.0.0.0 npm start        # listens on every interface, port 8787 (PORT changes it)
```

Find the laptop's LAN address:

| OS      | Command                                              |
| ------- | ---------------------------------------------------- |
| macOS   | `ipconfig getifaddr en0`                             |
| Linux   | `ip -4 addr show scope global` or `hostname -I`      |
| Windows | `ipconfig` (the "IPv4 Address" of the Wi-Fi adapter) |

With the phone on the same Wi-Fi, enter e.g. `192.168.1.20:8787` in the app. If it cannot
connect, check the laptop's firewall allows inbound TCP 8787 and that the router does not
isolate Wi-Fi clients from each other ("AP/client isolation", common on guest networks).

Leave `VECTOR_PUBLIC_ORIGIN` unset in this mode: the session cookie must not be marked
`Secure`, or the phone drops it over plain http.

### On a VPS, over HTTPS

Put the server behind a reverse proxy that terminates TLS with a publicly trusted certificate
(Caddy or nginx with Let's Encrypt), keep the server itself on localhost, and tell it its
public address:

```sh
VECTOR_PUBLIC_ORIGIN=https://vector.example.com VECTOR_TRUST_PROXY=1 npm start
```

The proxy must not buffer `/api/events` (Server-Sent Events). After creating your account, set
`VECTOR_ALLOW_SIGNUP=0`. In the app enter `vector.example.com`.

A VPN such as Tailscale or WireGuard also works: enter the server's VPN address.

## 2. Get the APK

**From CI.** Every push runs `.github/workflows/android.yml`, which runs the unit tests and
uploads `vector-debug-apk` as a workflow artifact (Actions → the run → Artifacts).

**Build it yourself.** You need JDK 17 or newer and the Android SDK (platform `android-37.0`,
build-tools `37.0.0`); point `ANDROID_HOME` at the SDK or put `sdk.dir=…` in
`android/local.properties`.

```sh
cd android
./gradlew test             # JVM unit tests: address/navigation logic and the speech protocol
./gradlew lint
./gradlew assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease  # app/build/outputs/apk/release/app-release-unsigned.apk
```

`assembleRelease` signs the APK only when it is given a key: either the environment variables
`VECTOR_KEYSTORE_FILE`, `VECTOR_KEYSTORE_PASSWORD`, `VECTOR_KEY_ALIAS` and
`VECTOR_KEY_PASSWORD`, or a gitignored `android/keystore.properties` with `storeFile`,
`storePassword`, `keyAlias` and `keyPassword`. No keystore or password belongs in the
repository. An unsigned APK cannot be installed; use the debug APK or sign the release one.

## 3. Install it (sideload)

Copy `app-debug.apk` to the phone and open it; Android asks once to allow installing from that
source (the browser or file manager you opened it with). Or, with USB debugging on:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Requires Android 8.0 (API 26) or newer. The debug APK is signed with a per-machine debug key:
an APK built on a different machine (or by CI) will not install over it, so uninstall first
when switching between sources.

## What the app does

- **Setup screen.** Accepts `192.168.1.20:8787`, `http://…` or `https://…`. Without a scheme
  it uses `https`, except for private/LAN addresses (10.x, 172.16–31.x, 192.168.x, 100.64/10,
  `localhost`, `.local`, single-label names), where it uses `http`. It then requests
  `GET <address>/api/auth/me` and accepts a JSON answer with status 200 or 401 as a Vector
  server. It reports separately: unreachable, something else answered, and TLS failure.
- **Main screen.** A full-screen WebView on that origin, drawn edge to edge. Cookies persist,
  so you stay signed in. Back goes back in the page history and leaves the app when there is
  none. The page survives rotation; after the system kills the app in the background, the
  history is restored and the page reloads.
- **Failure screen.** If the page cannot be loaded you get a native screen with **Retry** and
  **Change server**, never a blank page.
- **Change server.** Long-press the launcher icon → **Change server**. Also on the failure
  screen.

## Voice input

Android's WebView has no Web Speech API, so the app lends the page the phone's own speech
recognizer. When you tap the page's mic button, the app opens the system speech dialog
("Tell Vector what to do"); when you finish, the recognised text goes into the page.

- **Where the audio goes.** The system speech service on the phone (usually Google's, or
  whichever recognizer the phone is set to use) records and transcribes your voice, under its
  own privacy terms; it may process the audio on the device or in its cloud. The Vector app
  and your Vector server never receive audio, only the resulting text.
- **No microphone permission.** The app does not request `RECORD_AUDIO`; the speech service
  holds the microphone, not Vector. The app's permissions are unchanged.
- **Language.** The phone's default language.
- **When there is no mic button.** If the phone has no speech recognizer, the page is told
  `unavailable`. If the phone's WebView is too old to support the bridge (it needs web message
  listener support, present in current Android System WebView releases), the app exposes
  nothing and the page hides the button.

How the page talks to the app: the app registers a `VectorNative` object with androidx.webkit's
`WebViewCompat.addWebMessageListener`, scoped to exactly the saved server origin (scheme, host
and port), so pages on any other origin, and subframes, cannot reach it. The page posts the
string `{"type":"speech.start","id":"<id>"}` and gets one reply on the same channel:
`{"type":"speech.result","id":"<id>","text":"…"}` or
`{"type":"speech.error","id":"<id>","error":"cancelled"|"no_match"|"unavailable"|"busy"}`.
Only one request runs at a time (others get `busy`); a request made while the app is not in
the foreground is answered `cancelled`. If Android recreates the screen while the speech dialog
is open, the reloaded page starts fresh and the late result is dropped. Malformed messages, ids
longer than 64 characters and messages from subframes are ignored. Switching to another server
re-registers the bridge for the new origin only.

## What it does not do

- **No approvals while the app is in the background.** The live stream only runs while the
  app is open. Being notified when the agent wants approval needs a push channel; that is the
  next step and is not in this version.
- No notifications, camera, location, file upload or downloads. The page's own microphone
  requests (`getUserMedia`) are denied; voice input goes through the system recognizer instead
  (see [Voice input](#voice-input)).
- No analytics, crash reporting, ads or third-party SDKs. The only dependencies are AndroidX
  core, activity, appcompat and webkit.

## Security notes

- **Cleartext http is allowed app-wide.** Home-Wi-Fi servers are plain `http://192.168.x.x`,
  and Android's network security config cannot whitelist addresses chosen at runtime, so the
  app cannot allow "only my server". To compensate, the setup screen shows a warning whenever
  the address is plain http: traffic on that network, your password included, is unencrypted.
  Use http only on your own Wi-Fi or over a VPN; use https for anything reachable from the
  internet.
- **TLS errors are never bypassed.** An untrusted, expired or mismatched certificate shows the
  failure screen; there is no "continue anyway". Only the system certificate store is trusted,
  so a private CA installed by the user (for example Caddy's internal CA) is not accepted. Use
  a publicly trusted certificate.
- **Navigation is pinned to your server's origin.** Only URLs with exactly the saved scheme,
  host and port load in the app. Other http(s) links open in your browser; `intent:`,
  `file:`, `content:`, `javascript:` and every other scheme are refused, as are URLs carrying
  credentials (`http://server@evil.example`).
- **WebView hardening.** No `addJavascriptInterface` object is exposed to the page. The only
  bridge is the voice-input `VectorNative` message listener, which WebView exposes to the saved
  server origin alone and which can do one thing: open the system speech dialog. File and content
  access, geolocation, mixed content and third-party cookies are off; Safe Browsing is on;
  remote debugging is enabled only in debug builds.
- **Permissions.** The app requests `INTERNET` and nothing else; in particular no microphone
  permission, because voice input runs in the system speech recognizer. The manifest also contains
  `dev.vector.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which AndroidX declares for the
  app's own use (signature-level, private to this app); it grants no access to anything and
  the user is never asked for it.
- **Backups are off.** The saved address and session cookies are excluded from cloud backup
  and device transfer.
- The saved server address lives in the app's private SharedPreferences; the session is an
  httpOnly cookie in the WebView's private cookie store. Uninstalling removes both.
