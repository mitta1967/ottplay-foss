package play.ott.foss

import android.app.Activity
import android.content.Intent
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

/** Explicit file imports are copied into private storage; no broad storage permission is needed. */
@CapacitorPlugin(name = "LocalMedia")
class LocalMediaPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private val clients = Executors.newFixedThreadPool(4)
    private val connections = java.util.Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())
    private var listener: ServerSocket? = null
    private val token = UUID.randomUUID().toString().replace("-", "")
    @Volatile private var picking = false
    @Volatile private var destroyed = false
    private val directory: File get() = File(context.filesDir, "offline-media").apply { mkdirs() }

    @Synchronized private fun startServer(): Int {
        check(!destroyed) { "Media owner destroyed" }
        listener?.let { return it.localPort }
        val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        listener = socket
        Thread({
            try {
                while (!socket.isClosed) {
                    val client = socket.accept()
                    if (connections.size >= 4) { client.close(); continue }
                    connections.add(client)
                    try { clients.execute { try { serve(client) } finally { connections.remove(client); client.close() } } }
                    catch (_: Exception) { connections.remove(client); client.close() }
                }
            } catch (_: IOException) { /* destroyed */ }
        }, "ott-offline-media").start()
        return socket.localPort
    }

    private fun privateFile(file: File): Boolean = file.isFile &&
        file.canonicalFile == File(directory.canonicalFile, file.name)

    override fun load() {
        worker.execute {
            // Interrupted imports never become library entries; discard their private staging files.
            directory.listFiles().orEmpty().filter { it.name.endsWith(".part") ||
                (it.name.endsWith(".media") && !File(directory, it.name.removeSuffix(".media") + ".json").isFile) }
                .forEach { it.delete() }
        }
    }

    private fun snapshot(): JSObject {
        val port = startServer()
        val items = directory.listFiles().orEmpty().filter { it.name.endsWith(".json") }.sortedBy { it.name }.mapNotNull { meta ->
            try {
                if (!privateFile(meta)) return@mapNotNull null
                val item = JSONObject(meta.readText())
                val id = item.getString("id")
                if (!validId(id)) return@mapNotNull null
                val file = File(directory, "$id.media")
                if (!privateFile(file)) return@mapNotNull null
                JSObject().apply {
                    put("id", id); put("name", item.getString("name")); put("mime", item.getString("mime"))
                    put("size", file.length()); put("url", "http://127.0.0.1:$port/$token/$id")
                }
            } catch (_: Exception) { null }
        }
        return JSObject().put("available", true).put("persistent", true).put("storage", "device").put("items", JSArray(items))
    }

    @PluginMethod fun list(call: PluginCall) {
        worker.execute { try { call.resolve(snapshot()) } catch (_: Exception) { call.reject("Local media unavailable") } }
    }

    @PluginMethod fun remove(call: PluginCall) {
        val id = call.getString("id").orEmpty()
        if (!validId(id)) { call.reject("Invalid local media ID"); return }
        worker.execute {
            try {
                val media = File(directory, "$id.media")
                if (media.exists() && !media.delete()) throw IOException("Delete failed")
                File(directory, "$id.json").delete()
                call.resolve(snapshot())
            } catch (_: Exception) { call.reject("Unable to delete local media") }
        }
    }

    @Synchronized @PluginMethod fun importFiles(call: PluginCall) {
        if (picking) { call.reject("A media picker is already open"); return }
        picking = true
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("video/*", "audio/*"))
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        try { startActivityForResult(call, intent, "selected") }
        catch (_: Exception) { picking = false; call.reject("This device has no document picker") }
    }

    @ActivityCallback private fun selected(call: PluginCall?, result: ActivityResult) {
        picking = false
        if (call == null) return
        if (result.resultCode != Activity.RESULT_OK) {
            worker.execute { try { call.resolve(snapshot()) } catch (_: Exception) { call.reject("Local media unavailable") } }
            return
        }
        val data = result.data
        val uris = mutableListOf<android.net.Uri>()
        data?.clipData?.let { clip -> for (index in 0 until clip.itemCount) uris.add(clip.getItemAt(index).uri) }
        if (uris.isEmpty()) data?.data?.let { uris.add(it) }
        if (uris.size > 128) { call.reject("Import at most 128 files at once"); return }
        worker.execute {
            val created = mutableListOf<File>()
            try {
                for (uri in uris.distinct()) {
                    var name = "Local media"
                    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                        if (cursor.moveToFirst()) name = cursor.getString(0).orEmpty().take(256)
                    }
                    val declaredMime = context.contentResolver.getType(uri).orEmpty()
                    val mime = if (declaredMime.isEmpty() || declaredMime == "application/octet-stream")
                        LocalMediaRange.mime(name) else declaredMime
                    require(mime.startsWith("video/") || mime.startsWith("audio/")) { "Unsupported media type" }
                    val id = UUID.randomUUID().toString()
                    val partial = File(directory, "$id.part")
                    val media = File(directory, "$id.media")
                    val metadata = File(directory, "$id.json")
                    val metadataPartial = File(directory, "$id.json.part")
                    created.add(partial); created.add(media); created.add(metadata); created.add(metadataPartial)
                    context.contentResolver.openInputStream(uri)?.use { input ->
                        partial.outputStream().use { output ->
                            val buffer = ByteArray(65536)
                            var total = 0L
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                total += count
                                require(total <= 8L * 1024 * 1024 * 1024) { "File exceeds 8 GiB" }
                                check(!destroyed)
                                output.write(buffer, 0, count)
                            }
                        }
                    } ?: throw IOException("Unreadable media")
                    check(partial.renameTo(media))
                    metadataPartial.writeText(JSONObject().put("id", id).put("name", name).put("mime", mime).toString())
                    check(metadataPartial.renameTo(metadata))
                }
                call.resolve(snapshot())
            } catch (_: Exception) {
                created.forEach { it.delete() }
                call.reject("Media import failed; check file type and free storage")
            }
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.soTimeout = 5000
            val input = socket.getInputStream().buffered()
            var budget = 8192
            val deadline = System.nanoTime() + 5_000_000_000L
            fun line(): String {
                val text = StringBuilder()
                while (true) {
                    if (--budget < 0) throw IOException("Headers too large")
                    val remaining = (deadline - System.nanoTime()) / 1_000_000L
                    if (remaining <= 0) throw IOException("Header timeout")
                    socket.soTimeout = remaining.coerceAtMost(5000L).toInt().coerceAtLeast(1)
                    val next = input.read()
                    if (next < 0) throw IOException("Incomplete headers")
                    if (next == 10) return text.toString().trimEnd('\r')
                    text.append(next.toChar())
                }
            }
            val first = line().split(" ")
            if (first.size != 3 || first[2] !in listOf("HTTP/1.0", "HTTP/1.1")) return
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = line()
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon <= 0) return
                val key = line.substring(0, colon).lowercase()
                if (headers.containsKey(key)) return
                headers[key] = line.substring(colon + 1).trim()
            }
            val output = socket.getOutputStream().buffered()
            fun reply(code: Int, extra: String = "", length: Long = 0) {
                output.write(("HTTP/1.1 $code ${if (code == 200) "OK" else if (code == 206) "Partial Content" else "Response"}\r\n" +
                    "Connection: close\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Accept-Ranges, Content-Range, Content-Length\r\n" +
                    "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range\r\nAccess-Control-Allow-Private-Network: true\r\nCache-Control: no-store\r\n" +
                    "Content-Length: $length\r\n$extra\r\n").toByteArray(Charsets.US_ASCII))
            }
            val path = first[1].split('/')
            if (path.size != 3 || path[1] != token || !validId(path[2])) { reply(404); output.flush(); return }
            if (first[0] == "OPTIONS") { reply(204); output.flush(); return }
            if (first[0] != "GET" && first[0] != "HEAD") { reply(405); output.flush(); return }
            val file = File(directory, "${path[2]}.media")
            val metadata = File(directory, "${path[2]}.json")
            if (!privateFile(file) || !privateFile(metadata)) { reply(404); output.flush(); return }
            val size = file.length()
            val range = try { LocalMediaRange.parse(headers["range"], size) } catch (_: IllegalArgumentException) {
                reply(416, "Content-Range: bytes */$size\r\n"); output.flush(); return
            }
            val mime = JSONObject(metadata.readText()).getString("mime").filter { it > ' ' && it < '\u007f' }
            val length = if (size == 0L) 0 else range.last - range.first + 1
            reply(if (headers.containsKey("range")) 206 else 200,
                "Content-Type: $mime\r\nAccept-Ranges: bytes\r\n" +
                    if (headers.containsKey("range")) "Content-Range: bytes ${range.first}-${range.last}/$size\r\n" else "", length)
            if (first[0] == "GET" && length > 0) RandomAccessFile(file, "r").use { media ->
                media.seek(range.first)
                var remaining = length
                val buffer = ByteArray(65536)
                while (remaining > 0) {
                    val count = media.read(buffer, 0, minOf(remaining, buffer.size.toLong()).toInt())
                    if (count < 0) break
                    output.write(buffer, 0, count)
                    remaining -= count
                }
            }
            output.flush()
        } catch (_: Exception) { /* disconnected or malformed client */ }
    }

    override fun handleOnDestroy() {
        synchronized(this) {
            destroyed = true
            listener?.close(); listener = null
        }
        connections.forEach { try { it.close() } catch (_: Exception) { } }
        clients.shutdownNow(); worker.shutdownNow()
        super.handleOnDestroy()
    }

    companion object { private fun validId(id: String) = id.matches(Regex("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}")) }
}
