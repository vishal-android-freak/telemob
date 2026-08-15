package com.naarang.telemob.teleport

import android.os.Trace

internal class GhosttyTerminalEngine(columns: Int, rows: Int) : AutoCloseable {
  private var handle = nativeCreate(columns, rows)
  @Volatile private var preparedSnapshot: ByteArray? = null

  init {
    check(handle != 0L) { "Unable to create the native Ghostty terminal." }
  }

  @Synchronized
  fun reset() {
    preparedSnapshot = null
    withHandle(nativeReset = ::nativeReset)
  }

  @Synchronized
  fun write(data: ByteArray) {
    val current = handle
    if (current != 0L && data.isNotEmpty()) nativeWrite(current, data)
  }

  @Synchronized
  fun resize(columns: Int, rows: Int, cellWidth: Int, cellHeight: Int): Boolean {
    val current = handle
    return current != 0L && nativeResize(current, columns, rows, cellWidth, cellHeight)
  }

  @Synchronized
  fun prepareSnapshot(): ByteArray? {
    Trace.beginSection("Telemob.prepareSnapshot")
    try {
      val current = handle
      val next = if (current == 0L) null else nativeSnapshot(current)
      if (next != null) preparedSnapshot = next
      return next
    } finally {
      Trace.endSection()
    }
  }

  fun snapshot(): ByteArray? = preparedSnapshot

  @Synchronized
  fun scroll(rows: Int) {
    val current = handle
    if (current != 0L && rows != 0) nativeScroll(current, rows)
  }

  @Synchronized
  fun scrollToBottom() = withHandle(nativeReset = ::nativeScrollToBottom)

  @Synchronized
  fun select(startColumn: Int, startRow: Int, endColumn: Int, endRow: Int): Boolean {
    val current = handle
    return current != 0L && nativeSelect(
      current,
      startColumn,
      startRow,
      endColumn,
      endRow
    )
  }

  @Synchronized
  fun clearSelection() = withHandle(nativeReset = ::nativeClearSelection)

  @Synchronized
  fun selectionText(): String? {
    val current = handle
    if (current == 0L) return null
    return nativeSelectionText(current)
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
  }

  @Synchronized
  fun find(query: String, backwards: Boolean): Boolean {
    val current = handle
    return current != 0L && query.isNotEmpty() && nativeFind(
      current,
      query.toByteArray(Charsets.UTF_8),
      backwards
    )
  }

  @Synchronized
  fun hyperlink(column: Int, row: Int): String? {
    val current = handle
    if (current == 0L) return null
    return nativeHyperlink(current, column, row)
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
  }

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
  fun takeTitle(): String? {
    val current = handle
    if (current == 0L) return null
    val bytes = nativeTakeTitle(current) ?: return null
    return bytes.toString(Charsets.UTF_8)
  }

  @Synchronized
  fun takeBellCount(): Int {
    val current = handle
    return if (current == 0L) 0 else nativeTakeBellCount(current)
  }

  @Synchronized
  fun encodeKey(key: Int, text: String, modifiers: Int, action: Int): String? {
    val current = handle
    if (current == 0L) return null
    return nativeEncodeKey(current, key, text.toByteArray(Charsets.UTF_8), modifiers, action)
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
  }

  @Synchronized
  fun encodeMouse(action: Int, button: Int, modifiers: Int, column: Int, row: Int): String? {
    val current = handle
    if (current == 0L) return null
    return nativeEncodeMouse(current, action, button, modifiers, column, row)
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
  }

  @Synchronized
  fun encodeFocus(focused: Boolean): String? {
    val current = handle
    if (current == 0L) return null
    return nativeEncodeFocus(current, focused)
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
  }

  @Synchronized
  fun encodePaste(data: String): String? {
    val current = handle
    if (current == 0L) return null
    return nativeEncodePaste(current, data.toByteArray(Charsets.UTF_8))
      ?.takeIf(ByteArray::isNotEmpty)
      ?.toString(Charsets.UTF_8)
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
  private external fun nativeSelect(
    handle: Long,
    startColumn: Int,
    startRow: Int,
    endColumn: Int,
    endRow: Int
  ): Boolean
  private external fun nativeClearSelection(handle: Long)
  private external fun nativeSelectionText(handle: Long): ByteArray?
  private external fun nativeFind(handle: Long, query: ByteArray, backwards: Boolean): Boolean
  private external fun nativeHyperlink(handle: Long, column: Int, row: Int): ByteArray?
  private external fun nativeModes(handle: Long): BooleanArray?
  private external fun nativeTakePtyWrite(handle: Long): ByteArray?
  private external fun nativeTakeTitle(handle: Long): ByteArray?
  private external fun nativeTakeBellCount(handle: Long): Int
  private external fun nativeEncodeKey(
    handle: Long,
    key: Int,
    text: ByteArray,
    modifiers: Int,
    action: Int
  ): ByteArray?
  private external fun nativeEncodeMouse(
    handle: Long,
    action: Int,
    button: Int,
    modifiers: Int,
    column: Int,
    row: Int
  ): ByteArray?
  private external fun nativeEncodeFocus(handle: Long, focused: Boolean): ByteArray?
  private external fun nativeEncodePaste(handle: Long, data: ByteArray): ByteArray?

  private companion object {
    init {
      System.loadLibrary("telemob_terminal_jni")
    }
  }
}
