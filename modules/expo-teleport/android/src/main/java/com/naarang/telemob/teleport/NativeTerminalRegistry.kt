package com.naarang.telemob.teleport

import java.lang.ref.WeakReference
import java.util.TreeMap
import org.json.JSONObject

internal object NativeTerminalRegistry {
  data class Modes(
    val alternateScreen: Boolean,
    val mouseTracking: Boolean,
    val bracketedPaste: Boolean
  )

  private const val initialColumns = 84
  private const val initialRows = 40

  private data class Session(
    val engine: GhosttyTerminalEngine = GhosttyTerminalEngine(initialColumns, initialRows),
    var lastSequence: Long = 0,
    val pending: TreeMap<Long, String> = TreeMap(),
    val views: MutableSet<WeakReference<TeleportTerminalView>> = mutableSetOf()
  )

  private val sessions = mutableMapOf<String, Session>()

  @Synchronized
  fun prepare(sessionId: String) {
    if (sessionId.isNotBlank()) sessions.getOrPut(sessionId, ::Session)
  }

  fun handleEvent(event: JSONObject) {
    val sessionId = event.optString("sessionId")
    if (sessionId.isBlank()) return
    when (event.optString("type")) {
      "data" -> feed(sessionId, event.optLong("sequence"), event.optString("data"))
      "closed" -> close(sessionId)
    }
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
        enqueue(session, chunk.optLong("sequence"), chunk.optString("data"))
      }
      notifyViews(session)
    }
  }

  @Synchronized
  fun attach(sessionId: String, view: TeleportTerminalView): GhosttyTerminalEngine? {
    if (sessionId.isBlank()) return null
    val session = sessions.getOrPut(sessionId, ::Session)
    session.views.removeAll { reference -> reference.get() == null || reference.get() === view }
    session.views.add(WeakReference(view))
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
    sessions[sessionId]?.engine?.resize(columns, rows, cellWidth, cellHeight)
  }

  @Synchronized
  fun scroll(sessionId: String, rows: Int) {
    val session = sessions[sessionId] ?: return
    session.engine.scroll(rows)
    notifyViews(session)
  }

  @Synchronized
  fun scrollToBottom(sessionId: String) {
    val session = sessions[sessionId] ?: return
    session.engine.scrollToBottom()
    notifyViews(session)
  }

  @Synchronized
  fun modes(sessionId: String): Modes? {
    val values = sessions[sessionId]?.engine?.modes() ?: return null
    if (values.size < 3) return null
    return Modes(values[0], values[1], values[2])
  }

  @Synchronized
  fun takePtyWrite(sessionId: String): String? = sessions[sessionId]?.engine?.takePtyWrite()

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
  private fun feed(sessionId: String, sequence: Long, data: String) {
    val session = sessions.getOrPut(sessionId, ::Session)
    enqueue(session, sequence, data)
    notifyViews(session)
  }

  private fun enqueue(session: Session, sequence: Long, data: String) {
    if (sequence <= session.lastSequence || data.isEmpty()) return
    session.pending[sequence] = data
    while (true) {
      val next = session.pending.remove(session.lastSequence + 1) ?: break
      session.engine.write(next)
      session.lastSequence += 1
    }
  }

  private fun notifyViews(session: Session) {
    session.views.removeAll { reference ->
      val view = reference.get()
      if (view == null) true else {
        view.requestRender()
        false
      }
    }
  }
}
