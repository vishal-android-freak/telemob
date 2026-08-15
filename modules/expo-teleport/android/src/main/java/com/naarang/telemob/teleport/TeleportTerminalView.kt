package com.naarang.telemob.teleport

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.kotlin.viewevent.EventDispatcher
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

class TeleportTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  internal val onDimensions by EventDispatcher<Map<String, Int>>()

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
    typeface = Typeface.MONOSPACE
  }
  private var engine: GhosttyTerminalEngine? = null
  private var cellWidth = 1f
  private var cellHeight = 1f
  private var baselineOffset = 1f
  private var columns = 0
  private var rows = 0
  private var attached = false

  internal var sessionId: String = ""
    set(value) {
      if (field == value) return
      if (attached) NativeTerminalRegistry.detach(field, this)
      field = value
      engine = if (attached) NativeTerminalRegistry.attach(value, this) else null
      columns = 0
      rows = 0
      updateTerminalSize(width, height)
      requestRender()
    }

  internal var fontSize: Float = 12f
    set(value) {
      field = value.coerceIn(6f, 32f)
      updateFontMetrics()
      updateTerminalSize(width, height)
      requestRender()
    }

  init {
    setWillNotDraw(false)
    isFocusable = false
    updateFontMetrics()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true
    engine = NativeTerminalRegistry.attach(sessionId, this)
    updateTerminalSize(width, height)
  }

  override fun onDetachedFromWindow() {
    NativeTerminalRegistry.detach(sessionId, this)
    engine = null
    attached = false
    super.onDetachedFromWindow()
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    clipBounds = Rect(0, 0, width, height)
    updateTerminalSize(width, height)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    // React Native may disable parent child-clipping to implement
    // `overflow: visible`. Canvas.drawColor() otherwise fills that expanded
    // clip and paints over sibling React views such as the terminal header.
    canvas.clipRect(0f, 0f, width.toFloat(), height.toFloat())
    val snapshot = engine?.snapshot()
    if (snapshot == null || snapshot.size < snapshotHeaderSize) {
      drawViewBackground(canvas, terminalBackground)
      return
    }

    val snapshotColumns = readU16(snapshot, 0)
    val snapshotRows = readU16(snapshot, 2)
    val cursorColumn = readU16(snapshot, 4)
    val cursorRow = readU16(snapshot, 6)
    val cursorVisible = snapshot[8].toInt() != 0
    val cursorStyle = unsigned(snapshot[9])
    val background = color(snapshot, 10)
    val foreground = color(snapshot, 13)
    drawViewBackground(canvas, background)

    val maximumCells = (snapshot.size - snapshotHeaderSize) / snapshotCellSize
    val cellCount = minOf(snapshotColumns * snapshotRows, maximumCells)
    for (index in 0 until cellCount) {
      val offset = snapshotHeaderSize + index * snapshotCellSize
      val column = index % snapshotColumns
      val row = index / snapshotColumns
      val flags = unsigned(snapshot[offset + 6])
      val textLength = minOf(unsigned(snapshot[offset + 7]), terminalTextCapacity)
      var cellForeground = color(snapshot, offset)
      var cellBackground = color(snapshot, offset + 3)
      val blockCursor = cursorVisible && cursorStyle == cursorBlock &&
        column == cursorColumn && row == cursorRow
      if (blockCursor) {
        val originalForeground = cellForeground
        cellForeground = cellBackground
        cellBackground = originalForeground
      }

      val left = column * cellWidth
      val top = row * cellHeight
      if (cellBackground != background || blockCursor) {
        paint.color = cellBackground
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paint)
      }
      if (textLength == 0 || flags and flagInvisible != 0) continue

      paint.color = cellForeground
      paint.alpha = if (flags and flagFaint != 0) 166 else 255
      paint.style = Paint.Style.FILL
      paint.isFakeBoldText = flags and flagBold != 0
      paint.textSkewX = if (flags and flagItalic != 0) -0.2f else 0f
      paint.isUnderlineText = flags and flagUnderline != 0
      paint.isStrikeThruText = flags and flagStrikethrough != 0
      val text = String(snapshot, offset + 8, textLength, Charsets.UTF_8)
      canvas.drawText(text, left, top + baselineOffset, paint)
    }

    paint.alpha = 255
    paint.isFakeBoldText = false
    paint.textSkewX = 0f
    paint.isUnderlineText = false
    paint.isStrikeThruText = false
    if (cursorVisible && cursorStyle != cursorBlock) {
      drawCursor(canvas, cursorColumn, cursorRow, cursorStyle, foreground)
    }
  }

  internal fun requestRender() {
    postInvalidateOnAnimation()
  }

  private fun drawViewBackground(canvas: Canvas, color: Int) {
    paint.color = color
    paint.alpha = 255
    paint.style = Paint.Style.FILL
    canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
  }

  private fun updateFontMetrics() {
    paint.textSize = fontSize * resources.displayMetrics.density
    paint.typeface = Typeface.MONOSPACE
    cellWidth = max(1f, paint.measureText("M"))
    val metrics = paint.fontMetrics
    val glyphHeight = metrics.descent - metrics.ascent
    cellHeight = max(1f, ceil(glyphHeight * 1.12f))
    baselineOffset = (cellHeight - glyphHeight) / 2f - metrics.ascent
  }

  private fun updateTerminalSize(width: Int, height: Int) {
    if (width <= 0 || height <= 0) return
    val nextColumns = max(1, floor(width / cellWidth).toInt())
    val nextRows = max(1, floor(height / cellHeight).toInt())
    if (nextColumns == columns && nextRows == rows) return
    columns = nextColumns
    rows = nextRows
    if (sessionId.isNotBlank()) {
      NativeTerminalRegistry.resize(
        sessionId,
        columns,
        rows,
        ceil(cellWidth).toInt(),
        ceil(cellHeight).toInt()
      )
    }
    onDimensions(mapOf("columns" to columns, "rows" to rows))
  }

  private fun drawCursor(canvas: Canvas, column: Int, row: Int, style: Int, color: Int) {
    val left = column * cellWidth
    val top = row * cellHeight
    paint.color = color
    paint.alpha = 255
    when (style) {
      cursorBar -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top, left + max(2f, resources.displayMetrics.density), top + cellHeight, paint)
      }
      cursorUnderline -> {
        paint.style = Paint.Style.FILL
        canvas.drawRect(left, top + cellHeight - max(2f, resources.displayMetrics.density), left + cellWidth, top + cellHeight, paint)
      }
      else -> {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = max(1f, resources.displayMetrics.density)
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paint)
        paint.style = Paint.Style.FILL
      }
    }
  }

  private fun readU16(data: ByteArray, offset: Int): Int =
    unsigned(data[offset]) or (unsigned(data[offset + 1]) shl 8)

  private fun color(data: ByteArray, offset: Int): Int = Color.rgb(
    unsigned(data[offset]),
    unsigned(data[offset + 1]),
    unsigned(data[offset + 2])
  )

  private fun unsigned(value: Byte): Int = value.toInt() and 0xff

  private companion object {
    const val snapshotHeaderSize = 16
    const val terminalTextCapacity = 64
    const val snapshotCellSize = 8 + terminalTextCapacity
    const val terminalBackground = 0xff0b1117.toInt()
    const val cursorBar = 0
    const val cursorBlock = 1
    const val cursorUnderline = 2
    const val flagBold = 1 shl 0
    const val flagItalic = 1 shl 1
    const val flagFaint = 1 shl 2
    const val flagInvisible = 1 shl 5
    const val flagStrikethrough = 1 shl 6
    const val flagUnderline = 1 shl 7
  }
}
