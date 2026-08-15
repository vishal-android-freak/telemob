package com.naarang.telemob.teleport

import android.util.Base64
import android.os.Trace
import java.lang.ref.WeakReference
import java.util.TreeMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject

internal object NativeTerminalRegistry {
  data class Modes(
    val alternateScreen: Boolean,
    val mouseTracking: Boolean,
    val bracketedPaste: Boolean
  )

  data class Effects(val title: String?, val bellCount: Int)

  private const val initialColumns = 84
  private const val initialRows = 40

  private data class Session(
    val engine: GhosttyTerminalEngine = GhosttyTerminalEngine(initialColumns, initialRows),
    var lastSequence: Long = 0,
    val pending: TreeMap<Long, ByteArray> = TreeMap(),
    val views: MutableSet<WeakReference<TeleportTerminalView>> = mutableSetOf(),
    var renderScheduled: Boolean = false
  )

  private val sessions = mutableMapOf<String, Session>()
  private val renderer = Executors.newSingleThreadScheduledExecutor { task ->
    Thread(task, "TelemobTerminalRenderer").apply { isDaemon = true }
  }

  private val keyCodes = buildMap {
    put("text", 0)
    put("interrupt", 1)
    put("escape", 2)
    put("tab", 3)
    put("backspace", 4)
    put("enter", 5)
    put("insert", 6)
    put("delete", 7)
    put("pageup", 8)
    put("pagedown", 9)
    put("up", 10)
    put("down", 11)
    put("left", 12)
    put("right", 13)
    put("home", 14)
    put("end", 15)
    for (function in 1..12) put("f$function", 15 + function)
  }

  @Synchronized
  fun prepare(sessionId: String) {
    if (sessionId.isNotBlank()) sessions.getOrPut(sessionId, ::Session)
  }

  fun handleEvent(event: JSONObject) {
    val sessionId = event.optString("sessionId")
    if (sessionId.isBlank()) return
    when (event.optString("type")) {
      "data" -> event.optString("data").takeIf(String::isNotEmpty)?.let { data ->
        feed(sessionId, event.optLong("sequence"), data.toByteArray(Charsets.UTF_8))
      }
      "closed" -> close(sessionId)
    }
  }

  fun handleData(sessionId: String, sequence: Long, data: ByteArray) {
    if (sessionId.isBlank() || data.isEmpty()) return
    feed(sessionId, sequence, data)
  }

  fun handleReplay(snapshotJSON: String) {
    val snapshot = JSONObject(snapshotJSON)
    val sessionId = snapshot.optString("sessionId")
    if (sessionId.isBlank()) return
    val chunks = snapshot.optJSONArray("chunks") ?: return
    synchronized(this) {
      val session = sessions.getOrPut(sessionId, ::Session)
      if (snapshot.optBoolean("truncated") && chunks.length() > 0) {
        val firstSequence = chunks.getJSONObject(0).optLong("sequence")
        if (firstSequence > session.lastSequence + 1) {
          session.engine.reset()
          session.pending.clear()
          session.lastSequence = firstSequence - 1
        }
      }
      for (index in 0 until chunks.length()) {
        val chunk = chunks.getJSONObject(index)
        val bytes = chunk.optString("dataBase64").takeIf(String::isNotEmpty)?.let { encoded ->
          Base64.decode(encoded, Base64.DEFAULT)
        } ?: chunk.optString("data").toByteArray(Charsets.UTF_8)
        enqueue(session, chunk.optLong("sequence"), bytes)
      }
      scheduleRender(session)
    }
  }

  @Synchronized
  fun attach(sessionId: String, view: TeleportTerminalView): GhosttyTerminalEngine? {
    if (sessionId.isBlank()) return null
    val session = sessions.getOrPut(sessionId, ::Session)
    session.views.removeAll { reference -> reference.get() == null || reference.get() === view }
    session.views.add(WeakReference(view))
    scheduleRender(session)
    return session.engine
  }

  @Synchronized
  fun detach(sessionId: String, view: TeleportTerminalView) {
    sessions[sessionId]?.views?.removeAll { reference ->
      reference.get() == null || reference.get() === view
    }
  }

  @Synchronized
  fun resize(sessionId: String, columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    val session = sessions[sessionId] ?: return
    session.engine.resize(columns, rows, cellWidth, cellHeight)
    scheduleRender(session)
  }

  @Synchronized
  fun scroll(sessionId: String, rows: Int) {
    val session = sessions[sessionId] ?: return
    session.engine.scroll(rows)
    scheduleRender(session)
  }

  @Synchronized
  fun scrollToBottom(sessionId: String) {
    val session = sessions[sessionId] ?: return
    session.engine.scrollToBottom()
    scheduleRender(session)
  }

  @Synchronized
  fun select(
    sessionId: String,
    startColumn: Int,
    startRow: Int,
    endColumn: Int,
    endRow: Int
  ): Boolean {
    val session = sessions[sessionId] ?: return false
    val selected = session.engine.select(startColumn, startRow, endColumn, endRow)
    if (selected) scheduleRender(session)
    return selected
  }

  @Synchronized
  fun clearSelection(sessionId: String) {
    val session = sessions[sessionId] ?: return
    session.engine.clearSelection()
    scheduleRender(session)
  }

  @Synchronized
  fun selectionText(sessionId: String): String? =
    sessions[sessionId]?.engine?.selectionText()

  @Synchronized
  fun find(sessionId: String, query: String, backwards: Boolean): Boolean {
    val session = sessions[sessionId] ?: return false
    val found = session.engine.find(query, backwards)
    if (found) scheduleRender(session)
    return found
  }

  @Synchronized
  fun hyperlink(sessionId: String, column: Int, row: Int): String? =
    sessions[sessionId]?.engine?.hyperlink(column, row)

  @Synchronized
  fun modes(sessionId: String): Modes? {
    val values = sessions[sessionId]?.engine?.modes() ?: return null
    if (values.size < 3) return null
    return Modes(values[0], values[1], values[2])
  }

  @Synchronized
  fun takePtyWrite(sessionId: String): String? = sessions[sessionId]?.engine?.takePtyWrite()

  @Synchronized
  fun takeEffects(sessionId: String): Effects? {
    val engine = sessions[sessionId]?.engine ?: return null
    return Effects(engine.takeTitle(), engine.takeBellCount())
  }

  @Synchronized
  fun encodeKey(
    sessionId: String,
    key: String,
    text: String,
    ctrl: Boolean,
    alt: Boolean,
    shift: Boolean,
    action: String
  ): String? {
    val code = keyCodes[key.lowercase()] ?: return null
    val modifiers = (if (shift) 1 else 0) or (if (ctrl) 2 else 0) or (if (alt) 4 else 0)
    val actionCode = when (action.lowercase()) {
      "release" -> 0
      "repeat" -> 2
      else -> 1
    }
    return sessions[sessionId]?.engine?.encodeKey(code, text, modifiers, actionCode)
  }

  @Synchronized
  fun encodeMouseTap(sessionId: String, column: Int, row: Int): String? {
    val engine = sessions[sessionId]?.engine ?: return null
    val press = engine.encodeMouse(0, 1, 0, column, row).orEmpty()
    val release = engine.encodeMouse(1, 1, 0, column, row).orEmpty()
    return (press + release).ifEmpty { null }
  }

  @Synchronized
  fun encodeMouseEvent(
    sessionId: String,
    column: Int,
    row: Int,
    action: String
  ): String? {
    val engine = sessions[sessionId]?.engine ?: return null
    val actionCode = when (action) {
      "press" -> 0
      "release" -> 1
      "motion" -> 2
      else -> return null
    }
    return engine.encodeMouse(actionCode, 1, 0, column, row)
  }

  @Synchronized
  fun encodeMouseScroll(
    sessionId: String,
    column: Int,
    row: Int,
    direction: String,
    steps: Int
  ): String? {
    val engine = sessions[sessionId]?.engine ?: return null
    val button = if (direction == "up") 4 else 5
    return buildString {
      repeat(steps.coerceIn(1, 32)) {
        append(engine.encodeMouse(0, button, 0, column, row).orEmpty())
      }
    }.ifEmpty { null }
  }

  @Synchronized
  fun encodeFocus(sessionId: String, focused: Boolean): String? =
    sessions[sessionId]?.engine?.encodeFocus(focused)

  @Synchronized
  fun encodePaste(sessionId: String, data: String): String? =
    sessions[sessionId]?.engine?.encodePaste(data)

  @Synchronized
  fun close(sessionId: String) {
    val session = sessions.remove(sessionId) ?: return
    session.views.forEach { reference -> reference.get()?.requestRender() }
    session.engine.close()
  }

  @Synchronized
  fun closeAll() {
    val existing = sessions.values.toList()
    sessions.clear()
    existing.forEach { session ->
      session.views.forEach { reference -> reference.get()?.requestRender() }
      session.engine.close()
    }
  }

  @Synchronized
  private fun feed(sessionId: String, sequence: Long, data: ByteArray) {
    val session = sessions.getOrPut(sessionId, ::Session)
    enqueue(session, sequence, data)
    scheduleRender(session)
  }

  private fun enqueue(session: Session, sequence: Long, data: ByteArray) {
    if (sequence <= session.lastSequence || data.isEmpty()) return
    session.pending[sequence] = data
    while (true) {
      val next = session.pending.remove(session.lastSequence + 1) ?: break
      Trace.beginSection("Telemob.vtWrite")
      try {
        session.engine.write(next)
      } finally {
        Trace.endSection()
      }
      session.lastSequence += 1
    }
  }

  private fun scheduleRender(session: Session) {
    if (session.renderScheduled) return
    session.renderScheduled = true
    renderer.schedule({ render(session) }, renderCoalesceMs, TimeUnit.MILLISECONDS)
  }

  private fun render(session: Session) = synchronized(this) {
    if (sessions.values.none { it === session }) return@synchronized
    session.renderScheduled = false
    session.engine.prepareSnapshot()
    session.views.removeAll { reference ->
      val view = reference.get()
      if (view == null) true else {
        view.requestRender()
        false
      }
    }
  }

  private const val renderCoalesceMs = 8L
}
