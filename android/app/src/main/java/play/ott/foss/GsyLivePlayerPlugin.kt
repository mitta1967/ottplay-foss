package play.ott.foss

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.shuyu.gsyvideoplayer.GSYVideoManager
import com.shuyu.gsyvideoplayer.builder.GSYVideoOptionBuilder
import com.shuyu.gsyvideoplayer.listener.GSYSampleCallBack
import com.shuyu.gsyvideoplayer.player.IjkPlayerManager
import com.shuyu.gsyvideoplayer.player.PlayerFactory
import com.shuyu.gsyvideoplayer.utils.GSYVideoType
import com.shuyu.gsyvideoplayer.video.StandardGSYVideoPlayer
import tv.danmaku.ijk.media.exo2.Exo2PlayerManager

/** GSY player without its own controls: every control view stays hidden. */
class BareGsyPlayer(context: Context) : StandardGSYVideoPlayer(context) {
    override fun setViewShowState(view: View?, visibility: Int) {
        view?.visibility = View.GONE
    }
}

/**
 * Live playback through GSYVideoPlayer. The video view sits BEHIND the transparent
 * WebView, so the web UI (channel list, infobar, OSD) stays visible on top.
 * After the page loads a small script replaces the window.stb* device ABI.
 * Disable with localStorage ott_use_gsy = 0.
 */
@CapacitorPlugin(name = "GsyLive")
class GsyLivePlayerPlugin : Plugin() {

    companion object {
        private const val TAG = "GsyLive"
        private const val EXO_START_TIMEOUT_MS = 8000L
        private val ASPECT_TYPES = intArrayOf(
            GSYVideoType.SCREEN_TYPE_DEFAULT,
            GSYVideoType.SCREEN_TYPE_16_9,
            GSYVideoType.SCREEN_TYPE_4_3,
            GSYVideoType.SCREEN_TYPE_FULL,
            GSYVideoType.SCREEN_MATCH_FULL
        )

        private val SHIM = """
(function () {
  var w = window;
  var C = w.Capacitor;
  function noop() {}
  function call(m, o) {
    try {
      var p = C && C.Plugins && C.Plugins.GsyLive;
      if (p && typeof p[m] === 'function') return p[m](o || {});
      if (C && typeof C.nativePromise === 'function') return C.nativePromise('GsyLive', m, o || {});
    } catch (e) {}
    return Promise.reject(new Error('GsyLive unavailable'));
  }
  function log(msg) {
    try { w.console.log('[GsyShim] ' + msg); } catch (e) {}
    try { call('log', { msg: String(msg) }).then(noop, noop); } catch (e) {}
  }
  if (w.__gsyShim) { log('already installed'); return; }
  if (!C) { log('no Capacitor'); return; }
  try {
    if (w.localStorage.getItem('ott_use_gsy') === '0') { log('disabled by flag'); return; }
  } catch (e) {}
  w.__gsyShim = true;
  log('installing; stbPlay=' + typeof w.stbPlay + ' stbStop=' + typeof w.stbStop +
      ' transport=' + (w.__ottCoreTransport ? 'yes' : 'no') +
      ' plugin=' + (C.Plugins && C.Plugins.GsyLive ? 'proxy' : 'none') +
      ' nativePromise=' + typeof C.nativePromise);
  var st = { active: false, playing: false, pos: 0, len: 0, ended: false };
  var orig = { stop: w.stbStop };
  function skin(on) {
    var s = w.document.getElementById('gsy-skin');
    if (!s) {
      s = w.document.createElement('style');
      s.id = 'gsy-skin';
      (w.document.head || w.document.documentElement).appendChild(s);
    }
    s.textContent = on ? 'html,body{background:transparent!important}video{opacity:0!important}' : '';
  }
  function poll() {
    if (!st.active) return;
    call('status', {}).then(function (r) {
      if (!r || !st.active) return;
      st.pos = r.position || 0;
      st.len = r.duration || 0;
      st.playing = !!r.playing;
      st.ended = !!r.ended;
    }, noop);
  }
  setInterval(poll, 500);
  function stbPlay(url, pos) {
    var u = String(url || '');
    var p = Number(pos) || 0;
    var i = u.indexOf('#t=');
    if (i >= 0) {
      if (!p) p = Number(u.substring(i + 3)) || 0;
      u = u.substring(0, i);
    }
    log('stbPlay ' + u.split('?')[0].substring(0, 90) + ' pos=' + p);
    if (!st.active && typeof orig.stop === 'function') { try { orig.stop(); } catch (e) {} }
    st.active = true; st.playing = true; st.ended = false; st.pos = p; st.len = 0;
    skin(true);
    call('start', { url: u, position: p, headers: {} }).then(function (r) {
      log('start -> ' + JSON.stringify(r));
      if (r && r.ok === false) st.playing = false;
    }, function (e) {
      log('start failed: ' + e);
      st.playing = false;
    });
  }
  function stbStop() {
    if (!st.active) {
      if (typeof orig.stop === 'function') { try { orig.stop(); } catch (e) {} }
      return;
    }
    log('stbStop');
    st.active = false; st.playing = false; st.pos = 0; st.len = 0;
    call('stop', {}).then(noop, noop);
    skin(false);
  }
  function stbPause() {
    if (!st.active) return;
    st.playing = false;
    call('pause', {}).then(noop, noop);
  }
  function stbResume() {
    if (!st.active) return;
    st.playing = true;
    call('resume', {}).then(noop, noop);
  }
  function stbContinue() { if (st.playing) stbPause(); else stbResume(); }
  function stbIsPlaying() { return st.active && st.playing; }
  function stbGetPosTime() { return st.pos; }
  function stbGetLen() { return st.len; }
  function stbSetPosTime(t) {
    var v = Number(t) || 0;
    st.pos = v;
    if (st.active) call('seek', { position: v }).then(noop, noop);
  }
  var api = {
    stbPlay: stbPlay, stbStop: stbStop, stbPause: stbPause, stbResume: stbResume,
    stbContinue: stbContinue, stbIsPlaying: stbIsPlaying, stbGetPosTime: stbGetPosTime,
    stbGetLen: stbGetLen, stbSetPosTime: stbSetPosTime
  };
  var locked = {};
  function lock(k, fn) {
    try {
      Object.defineProperty(w, k, {
        configurable: true,
        enumerable: true,
        get: function () { return fn; },
        set: function () {}
      });
      locked[k] = true;
    } catch (e) {
      try { w[k] = fn; } catch (e2) {}
    }
  }
  function apply() {
    for (var k in api) {
      if (!locked[k] && w[k] !== api[k]) { try { w[k] = api[k]; } catch (e) {} }
    }
  }
  for (var key in api) lock(key, api[key]);
  log('locked=' + Object.keys(locked).join(',') + ' of ' + Object.keys(api).length);
  apply();
  setInterval(apply, 1000);
})();
"""
    }

    private val ui = Handler(Looper.getMainLooper())
    private var stopSubscription: (() -> Unit)? = null
    private var player: BareGsyPlayer? = null

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
        Log.i(TAG, "plugin load()")
        stopSubscription = NativeWork.onStandbyAsync { done ->
            val act = activity
            if (act == null) done()
            else act.runOnUiThread { try { tearDown() } finally { done() } }
        }
        bridge.addWebViewListener(object : WebViewListener() {
            override fun onPageLoaded(webView: WebView) {
                Log.i(TAG, "page loaded, injecting shim")
                webView.evaluateJavascript(SHIM, null)
            }
        })
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

    @PluginMethod
    fun log(call: PluginCall) {
        Log.i(TAG, "js: " + (call.getString("msg") ?: ""))
        call.resolve()
    }

    @PluginMethod
    fun start(call: PluginCall) {
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
                ensurePlayer(act)
                aspectIdx = aspect.coerceIn(0, ASPECT_TYPES.size - 1)
                usingIjk = engine == "ijk" ||
                    (engine == null && name.uppercase().contains("FHD"))
                PlayerFactory.setPlayManager(
                    if (usingIjk) IjkPlayerManager::class.java else Exo2PlayerManager::class.java
                )
                lastUrl = url
                lastName = name
                lastHeaders = headers
                lastPositionMs = positionMs
                Log.i(TAG, "start ijk=$usingIjk url=" + url.substringBefore('?').take(90))
                startPlay()
                ok(call)
            } catch (e: Exception) {
                Log.e(TAG, "start failed", e)
                fail(call, e.message ?: "start failed")
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
                    Log.i(TAG, "prepared ijk=$usingIjk")
                    notifyListeners("state", JSObject().apply { put("state", "ready") })
                }

                override fun onAutoComplete(url: String?, vararg objects: Any?) {
                    if (token != playToken) return
                    ended = true
                    notifyListeners("state", JSObject().apply { put("state", "ended") })
                }

                override fun onPlayError(url: String?, vararg objects: Any?) {
                    if (token != playToken) return
                    Log.e(TAG, "GSY play error (ijk=$usingIjk) url=$url")
                    if (!usingIjk) fallbackToIjk()
                    else notifyListeners("state", JSObject().apply { put("state", "error") })
                }
            })
            .build(p)
        p.startPlayLogic()
    }

    private fun fallbackToIjk() {
        if (usingIjk) return
        usingIjk = true
        Log.w(TAG, "Exo2 failed or timed out, falling back to IJK")
        PlayerFactory.setPlayManager(IjkPlayerManager::class.java)
        GSYVideoManager.releaseAllVideos()
        ui.post { startPlay() }
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (player == null) return@runOnUiThread fail(call, "no active player")
            GSYVideoManager.onPause()
            ok(call)
        }
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
        act.runOnUiThread {
            if (player == null) return@runOnUiThread fail(call, "no active player")
            GSYVideoManager.onResume()
            ok(call)
        }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val act = activity ?: return fail(call, "no activity")
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
    fun seek(call: PluginCall) {
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
    fun setAspect(call: PluginCall) {
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
    fun stop(call: PluginCall) {
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

    private fun ensurePlayer(act: Activity) {
        if (player != null) return
        val web = bridge.webView
        val parent = web.parent as ViewGroup
        val p = BareGsyPlayer(act).apply {
            isFocusable = false
            isClickable = false
        }
        parent.addView(
            p, 0,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
        web.setBackgroundColor(Color.TRANSPARENT)
        player = p
    }

    private fun tearDown() {
        playToken++
        ui.removeCallbacksAndMessages(null)
        GSYVideoManager.releaseAllVideos()
        val p = player
        player = null
        if (p != null) (p.parent as? ViewGroup)?.removeView(p)
    }
}
