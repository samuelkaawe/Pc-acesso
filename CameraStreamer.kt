package com.remotepc.app

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Matrix
import android.util.Size
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

data class CamArgs(
    val wsUrl: String,
    val front: Boolean,
    val width: Int,
    val height: Int,
    val fps: Int,
    val quality: Int
)

class CameraStreamer(
    private val activity: AppCompatActivity,
    private val args: CamArgs,
    private val status: (String) -> Unit
) {
    private val client = OkHttpClient()
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private var socket: WebSocket? = null
    private var provider: ProcessCameraProvider? = null

    @Volatile
    private var running = false

    @Volatile
    private var connected = false
    private var lastSent = 0L

    fun start() {
        running = true
        status("Conectando ao PC…")
        val req = Request.Builder().url(args.wsUrl).build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                status("Transmitindo para o PC")
                activity.runOnUiThread { bindCamera() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                status("PC: $text")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected = false
                if (running) {
                    status("Falha na conexão: ${t.message}")
                    stop()
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected = false
                if (running) {
                    status("Conexão encerrada pelo PC")
                    stop()
                }
            }
        })
    }

    private fun bindCamera() {
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener({
            try {
                val p = future.get()
                provider = p
                val portrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
                val size = if (portrait) Size(args.height, args.width) else Size(args.width, args.height)
                val analysis = ImageAnalysis.Builder()
                    .setTargetResolution(size)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .build()
                analysis.setAnalyzer(executor) { image -> analyze(image) }
                val selector = if (args.front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA
                p.unbindAll()
                p.bindToLifecycle(activity, selector, analysis)
            } catch (e: Exception) {
                status("Erro na câmera: ${e.message}")
                stop()
            }
        }, ContextCompat.getMainExecutor(activity))
    }

    private fun analyze(image: ImageProxy) {
        try {
            if (!running || !connected) return
            val now = System.currentTimeMillis()
            if (now - lastSent < 1000L / args.fps.coerceAtLeast(1)) return
            val sock = socket ?: return
            if (sock.queueSize() > 400_000L) return
            var bmp = image.toBitmap()
            val rot = image.imageInfo.rotationDegrees
            if (rot != 0) {
                val m = Matrix()
                m.postRotate(rot.toFloat())
                bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            }
            val out = ByteArrayOutputStream(64 * 1024)
            bmp.compress(Bitmap.CompressFormat.JPEG, args.quality, out)
            sock.send(out.toByteArray().toByteString())
            lastSent = now
        } catch (_: Exception) {
        } finally {
            image.close()
        }
    }

    fun stop() {
        if (!running && socket == null) return
        running = false
        connected = false
        try {
            socket?.close(1000, "bye")
        } catch (_: Exception) {
        }
        socket = null
        activity.runOnUiThread {
            try {
                provider?.unbindAll()
            } catch (_: Exception) {
            }
        }
    }
}
