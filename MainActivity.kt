package com.remotepc.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.text.InputType
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject

class MainActivity : AppCompatActivity() {

    private lateinit var root: FrameLayout
    private lateinit var connectView: LinearLayout
    private lateinit var webView: WebView
    private lateinit var hostInput: EditText
    private lateinit var statusText: TextView

    private var camera: CameraStreamer? = null
    private var pendingCam: CamArgs? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @Volatile
    private var interceptVolume = false

    private val camPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val a = pendingCam
            pendingCam = null
            if (granted && a != null) doStartCamera(a) else jsCall("onCamStatus", "Permissão da câmera negada")
        }

    private val fileLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
            val cb = fileCallback
            fileCallback = null
            cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        root.setBackgroundColor(Color.parseColor("#0f1115"))
        setContentView(root)

        buildWebView()
        buildConnectView()
        val match = ViewGroup.LayoutParams.MATCH_PARENT
        root.addView(webView, FrameLayout.LayoutParams(match, match))
        root.addView(connectView, FrameLayout.LayoutParams(match, match))
        webView.visibility = View.GONE

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.visibility == View.VISIBLE) {
                    webView.evaluateJavascript("(window.onBackKey ? window.onBackKey() : false)") { r ->
                        if (r != "true") moveTaskToBack(true)
                    }
                } else {
                    finish()
                }
            }
        })

        val saved = prefs().getString("host", "") ?: ""
        hostInput.setText(saved)
        if (saved.isNotEmpty() && savedInstanceState == null) connect()
    }

    private fun prefs() = getSharedPreferences("remotepc", Context.MODE_PRIVATE)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun buildConnectView() {
        connectView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(24), dp(24), dp(24), dp(24))
            setBackgroundColor(Color.parseColor("#0f1115"))
        }
        val title = TextView(this).apply {
            text = "RemotePC"
            textSize = 30f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
        }
        val sub = TextView(this).apply {
            text = "Digite o IP do PC (aparece na janela do servidor)"
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(16))
        }
        hostInput = EditText(this).apply {
            hint = "192.168.0.10:8765"
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
            imeOptions = EditorInfo.IME_ACTION_GO
            setOnEditorActionListener { _, _, _ ->
                connect()
                true
            }
        }
        val btn = Button(this).apply {
            text = "Conectar"
            setOnClickListener { connect() }
        }
        statusText = TextView(this).apply {
            setTextColor(Color.parseColor("#ff7777"))
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, 0)
        }
        connectView.addView(title)
        connectView.addView(sub)
        connectView.addView(hostInput, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        connectView.addView(btn, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        connectView.addView(statusText)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView() {
        webView = WebView(this)
        webView.setBackgroundColor(Color.parseColor("#0f1115"))
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.settings.setSupportZoom(false)
        webView.addJavascriptInterface(Bridge(), "Android")

        webView.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                if (request != null && request.isForMainFrame) {
                    showConnect("Não foi possível conectar. Confira o IP, o servidor e o Wi-Fi.")
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                if (filePathCallback == null || fileChooserParams == null) return false
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                return try {
                    fileLauncher.launch(fileChooserParams.createIntent())
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        webView.setDownloadListener { url, _, contentDisposition, mimetype, _ ->
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimetype)
                val req = DownloadManager.Request(Uri.parse(url))
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
                (this@MainActivity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                Toast.makeText(this@MainActivity, "Baixando $name", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Falha ao baixar", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun connect() {
        var h = hostInput.text.toString().trim().removePrefix("http://").removePrefix("https://").trimEnd('/')
        if (h.isEmpty()) {
            statusText.text = "Digite o IP do PC"
            return
        }
        if (!h.contains(":")) h += ":8765"
        prefs().edit().putString("host", h).apply()
        statusText.text = ""
        connectView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("http://$h/")
    }

    private fun showConnect(msg: String) {
        camera?.stop()
        camera = null
        interceptVolume = false
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        applyFullscreen(false)
        webView.keepScreenOn = false
        webView.stopLoading()
        webView.loadUrl("about:blank")
        webView.visibility = View.GONE
        connectView.visibility = View.VISIBLE
        statusText.text = msg
    }

    private fun applyFullscreen(on: Boolean) {
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            c.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun jsCall(fn: String, arg: String) {
        val q = JSONObject.quote(arg)
        runOnUiThread { webView.evaluateJavascript("window.$fn && window.$fn($q)", null) }
    }

    private fun requestCamera(a: CamArgs) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            doStartCamera(a)
        } else {
            pendingCam = a
            camPermLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun doStartCamera(a: CamArgs) {
        camera?.stop()
        val streamer = CameraStreamer(this, a) { msg -> jsCall("onCamStatus", msg) }
        camera = streamer
        streamer.start()
        webView.keepScreenOn = true
    }

    // Botões de volume viram botões programáveis quando a aba "Jogar" está aberta
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (interceptVolume && webView.visibility == View.VISIBLE &&
            (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP || event.keyCode == KeyEvent.KEYCODE_VOLUME_DOWN)
        ) {
            if (event.repeatCount == 0) {
                val name = if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP) "volup" else "voldown"
                val down = event.action == KeyEvent.ACTION_DOWN
                webView.evaluateJavascript("window.onHardwareKey && window.onHardwareKey('$name',$down)", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        camera?.stop()
        super.onDestroy()
    }

    inner class Bridge {
        @JavascriptInterface
        fun startCamera(wsUrl: String, front: Boolean, width: Int, height: Int, fps: Int, quality: Int) {
            runOnUiThread { requestCamera(CamArgs(wsUrl, front, width, height, fps, quality)) }
        }

        @JavascriptInterface
        fun stopCamera() {
            runOnUiThread {
                camera?.stop()
                camera = null
                webView.keepScreenOn = false
            }
        }

        @JavascriptInterface
        fun setInterceptVolume(on: Boolean) {
            interceptVolume = on
        }

        @JavascriptInterface
        fun setOrientation(mode: String) {
            runOnUiThread {
                requestedOrientation = when (mode) {
                    "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
                    else -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                }
            }
        }

        @JavascriptInterface
        fun setFullscreen(on: Boolean) {
            runOnUiThread { applyFullscreen(on) }
        }

        @JavascriptInterface
        fun setKeepScreenOn(on: Boolean) {
            runOnUiThread { webView.keepScreenOn = on || camera != null }
        }

        @JavascriptInterface
        fun disconnect() {
            runOnUiThread { showConnect("") }
        }
    }
}
