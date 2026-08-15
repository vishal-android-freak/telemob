package com.naarang.telemob.teleport

internal class GhosttyTerminalEngine(columns: Int, rows: Int) : AutoCloseable {
  private var handle = nativeCreate(columns, rows)

  init {
    check(handle != 0L) { "Unable to create the native Ghostty terminal." }
  }

  @Synchronized
  fun reset() = withHandle(nativeReset = ::nativeReset)

  @Synchronized
  fun write(data: String) {
    val current = handle
    if (current != 0L && data.isNotEmpty()) nativeWrite(current, data.toByteArray(Charsets.UTF_8))
  }

  @Synchronized
  fun resize(columns: Int, rows: Int, cellWidth: Int, cellHeight: Int): Boolean {
    val current = handle
    return current != 0L && nativeResize(current, columns, rows, cellWidth, cellHeight)
  }

  @Synchronized
  fun snapshot(): ByteArray? {
    val current = handle
    return if (current == 0L) null else nativeSnapshot(current)
  }

  @Synchronized
  fun scroll(rows: Int) {
    val current = handle
    if (current != 0L && rows != 0) nativeScroll(current, rows)
  }

  @Synchronized
  fun scrollToBottom() = withHandle(nativeReset = ::nativeScrollToBottom)

  @Synchronized
  fun modes(): BooleanArray? {
    val current = handle
    return if (current == 0L) null else nativeModes(current)
  }

  @Synchronized
  fun takePtyWrite(): String? {
    val current = handle
    if (current == 0L) return null
    val bytes = nativeTakePtyWrite(current) ?: return null
    return if (bytes.isEmpty()) null else bytes.toString(Charsets.UTF_8)
  }

  @Synchronized
  override fun close() {
    val current = handle
    handle = 0L
    if (current != 0L) nativeDestroy(current)
  }

  private inline fun withHandle(nativeReset: (Long) -> Unit) {
    val current = handle
    if (current != 0L) nativeReset(current)
  }

  private external fun nativeCreate(columns: Int, rows: Int): Long
  private external fun nativeDestroy(handle: Long)
  private external fun nativeReset(handle: Long)
  private external fun nativeWrite(handle: Long, data: ByteArray)
  private external fun nativeResize(
    handle: Long,
    columns: Int,
    rows: Int,
    cellWidth: Int,
    cellHeight: Int
  ): Boolean
  private external fun nativeSnapshot(handle: Long): ByteArray?
  private external fun nativeScroll(handle: Long, rows: Int)
  private external fun nativeScrollToBottom(handle: Long)
  private external fun nativeModes(handle: Long): BooleanArray?
  private external fun nativeTakePtyWrite(handle: Long): ByteArray?

  private companion object {
    init {
      System.loadLibrary("telemob_terminal_jni")
    }
  }
}
