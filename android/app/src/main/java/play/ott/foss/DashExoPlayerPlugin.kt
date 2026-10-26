package play.ott.foss

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.shuyu.gsyvideoplayer.GSYVideoManager
import com.shuyu.gsyvideoplayer.builder.GSYVideoOptionBuilder
import com.shuyu.gsyvideoplayer.listener.GSYSampleCallBack
import com.shuyu.gsyvideoplayer.player.IjkPlayerManager
import com.shuyu.gsyvideoplayer.player.PlayerFactory
import com.shuyu.gsyvideoplayer.utils.GSYVideoType
import com.shuyu.gsyvideoplayer.video.StandardGSYVideoPlayer
import tv.danmaku.ijk.media.exo2.Exo2PlayerManager

/**
 * Capacitor plugin backed by GSYVideoPlayer (Exo2 + IJK fallback).
 * Keeps the original DashExoPlayer name and method set so the TS side is unchanged.
 * Renders into an overlay on the Activity content view.
 */
@CapacitorPlugin(name = "DashExoPlayer")
class DashExoPlayerPlugin : Plugin() {

    companion object {
        private const val TAG = "DashExoPlayer"
        private const val CHANNEL_ID = "dash_player"
        private const val NOTIFICATION_ID = 4406
        private const val EXO_START_TIMEOUT_MS = 8000L
        private val ASPECT_TYPES = intArrayOf(
            GSYVideoType.SCREEN_TYPE_DEFAULT,
            GSYVideoType.SCREEN_TYPE_16_9,
            GSYVideoType.SCREEN_TYPE_4_3,
            GSYVideoType.SCREEN_TYPE_FULL,
            GSYVideoType.SCREEN_MATCH_FULL
        )
    }

    private val ui = Handler(Looper.getMainLooper())
    private var stopSubscription: (() -> Unit)? = null
    private var player: StandardGSYVideoPlayer? = null
    private var overlay: FrameLayout? = null

    private var playToken = 0
    private var prepared = false
    private var ended = false
    private var usingIjk = false
    private var aspectIdx = 0
    private var lastUrl = ""
    private var lastName = ""
    private var lastHeaders: Map<String, String> = emptyMap()
    private var lastPositionMs = 0L

    override fun load() {
        stopSubscription = NativeWork.onStandbyAsync { done ->
            val act = activity
            if (act == null) done()
            else act.runOnUiThread { try { tearDown() } finally { done() } }
        }
    }

    private fun fail(call: PluginCall, msg: String) {
        call.resolve(JSObject().apply {
            put("ok", false)
            put("error", msg)
        })
    }

    private fun ok(call: PluginCall) {
        call.resolve(JSObject().apply { put("ok", true) })
    }

    private fun emit(state: String) {
        notifyListeners("state", JSObject().apply {
            put("state", state)
            put("engine", if (usingIjk) "ijk" else "exo")
        })
    }

    @PluginMethod
    fun isDashSupported(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("ok", true)
            put("unsupported", false)
        })
    }

    @PluginMethod
    fun playDash(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrBlank()) return fail(call, "missing url")
        val positionMs = ((call.getDouble("position") ?: 0.0) * 1000.0).toLong()
        val name = call.getString("name") ?: ""
        val engine = call.getString("engine")
        val aspect = call.getInt("aspect") ?: aspectIdx
        val headers = HashMap<String, String>()
        call.getObject("headers")?.let { h ->
            val keys = h.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                h.getString(k)?.let { headers[k] = it }
            }
        }
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (NativeWork.isStandby) {
                call.reject("Player is in standby", "standby")
                return@runOnUiThread
            }
            try {
                ensureOverlay(act)
                aspectIdx = aspect.coerceIn(0, ASPECT_TYPES.size - 1)
                usingIjk = engine == "ijk" ||
                    (engine == null && name.uppercase().contains("FHD") &&
                        !url.lowercase().substringBefore('?').endsWith(".mpd"))
                PlayerFactory.setPlayManager(
                    if (usingIjk) IjkPlayerManager::class.java else Exo2PlayerManager::class.java
                )
                lastUrl = url
                lastName = name
                lastHeaders = headers
                lastPositionMs = positionMs
                startPlay()
                showOverlay()
                notifyPlaying(true)
                ok(call)
            } catch (e: Exception) {
                Log.e(TAG, "playDash failed", e)
                fail(call, e.message ?: "playDash failed")
            }
        }
    }

    private fun startPlay() {
        val p = player ?: return
        val token = ++playToken
        prepared = false
        ended = false
        if (!usingIjk) {
            ui.postDelayed({
                if (token == playToken && !prepared && !usingIjk) fallbackToIjk()
            }, EXO_START_TIMEOUT_MS)
        }
        GSYVideoType.setShowType(ASPECT_TYPES[aspectIdx])
        GSYVideoOptionBuilder()
            .setUrl(lastUrl)
            .setMapHeadData(lastHeaders)
            .setCacheWithPlay(false)
            .setIsTouchWiget(false)
            .setLooping(false)
            .setSeekOnStart(lastPositionMs)
            .setVideoTitle(lastName)
            .setVideoAllCallBack(object : GSYSampleCallBack() {
                override fun onPrepared(url: String?, vararg objects: Any?) {
                    if (token != playToken) return
                    prepared = true
                    emit("ready")
                }

                override fun onAutoComplete(url: String?, vararg objects: Any?) {
                    if (token != playToken) return
                    ended = true
                    emit("ended")
                }

                override fun onPlayError(url: String?, vararg objects: Any?) {
                    if (token != playToken) return
                    Log.e(TAG, "GSY play error (ijk=$usingIjk) url=$url")
                    if (!usingIjk) fallbackToIjk() else emit("error")
                }
            })
            .build(p)
        p.startPlayLogic()
    }

    private fun fallbackToIjk() {
        if (usingIjk) return
        usingIjk = true
        PlayerFactory.setPlayManager(IjkPlayerManager::class.java)
        GSYVideoManager.releaseAllVideos()
        ui.post { startPlay() }
    }

    @PluginMethod
    fun pauseDash(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (player == null) return@runOnUiThread fail(call, "no active player")
            GSYVideoManager.onPause()
            notifyPlaying(false)
            ok(call)
        }
    }

    @PluginMethod
    fun resumeDash(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (NativeWork.isStandby) {
                call.reject("Player is in standby", "standby")
                return@runOnUiThread
            }
            if (player == null) return@runOnUiThread fail(call, "no active player")
            GSYVideoManager.onResume()
            showOverlay()
            notifyPlaying(true)
            ok(call)
        }
    }

    @PluginMethod
    fun getPlaybackState(call: PluginCall) {
        val act = activity
        if (act == null) {
            call.resolve(JSObject().apply {
                put("ok", false)
                put("position", 0.0)
                put("duration", 0.0)
                put("playing", false)
                put("ended", false)
                put("error", "no activity")
            })
            return
        }
        act.runOnUiThread {
            val p = player
            call.resolve(JSObject().apply {
                put("ok", p != null)
                put("position", (p?.currentPositionWhenPlaying ?: 0).toLong().coerceAtLeast(0L) / 1000.0)
                put("duration", (p?.duration ?: 0).toLong().coerceAtLeast(0L) / 1000.0)
                put("playing", p != null && GSYVideoManager.instance().isPlaying)
                put("ended", ended)
                put("engine", if (usingIjk) "ijk" else "exo")
            })
        }
    }

    @PluginMethod
    fun seekDash(call: PluginCall) {
        val position = call.getDouble("position")
        if (position == null || !position.isFinite()) return fail(call, "invalid position")
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            val p = player ?: return@runOnUiThread fail(call, "no active player")
            var millis = (position.coerceAtLeast(0.0) * 1000.0).toLong()
            val dur = p.duration.toLong()
            if (dur > 0) millis = millis.coerceAtMost(dur)
            p.seekTo(millis)
            ok(call)
        }
    }

    @PluginMethod
    fun setAspectDash(call: PluginCall) {
        val idx = call.getInt("aspect") ?: return fail(call, "invalid aspect")
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (player == null) return@runOnUiThread fail(call, "no active player")
            aspectIdx = idx.coerceIn(0, ASPECT_TYPES.size - 1)
            lastPositionMs = (player?.currentPositionWhenPlaying ?: 0).toLong().coerceAtLeast(0L)
            startPlay()
            ok(call)
        }
    }

    @PluginMethod
    fun stopDash(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            tearDown()
            ok(call)
        }
    }

    override fun handleOnDestroy() {
        stopSubscription?.invoke()
        stopSubscription = null
        tearDown()
        super.handleOnDestroy()
    }

    private fun ensureOverlay(act: android.app.Activity) {
        if (overlay != null && player != null) return
        val root = act.findViewById<ViewGroup>(android.R.id.content)
        val wrap = FrameLayout(act).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
            isClickable = true
            elevation = 100f
        }
        val gsy = StandardGSYVideoPlayer(act).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            titleTextView.visibility = View.GONE
            backButton.visibility = View.GONE
            fullscreenButton.visibility = View.GONE
            isFocusable = false
        }
        wrap.addView(gsy)
        root.addView(wrap)
        overlay = wrap
        player = gsy
    }

    private fun showOverlay() {
        overlay?.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay?.visibility = View.GONE
    }

    private fun tearDown() {
        playToken++
        ui.removeCallbacksAndMessages(null)
        GSYVideoManager.releaseAllVideos()
        player = null
        hideOverlay()
        val ov = overlay
        if (ov != null) (ov.parent as? ViewGroup)?.removeView(ov)
        overlay = null
        cancelNotification()
    }

    private fun notifyPlaying(playing: Boolean) {
        val ctx = context ?: return
        ensureChannel()
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val contentPi = PendingIntent.getActivity(
            ctx, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle("OTT-play FOSS")
            .setContentText(if (playing) "Native playback (GSY)" else "Paused")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentIntent(contentPi)
            .setOngoing(playing)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()
        val nm = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun cancelNotification() {
        val ctx = context ?: return
        val nm = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        nm.cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ctx = context ?: return
        val nm = ctx.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Native playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply { setShowBadge(false) }
        )
    }
}
