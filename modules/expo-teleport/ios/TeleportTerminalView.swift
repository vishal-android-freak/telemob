import ExpoModulesCore
import UIKit

final class GhosttyTerminalEngine {
  struct Modes {
    let alternateScreen: Bool
    let mouseTracking: Bool
    let bracketedPaste: Bool
  }

  private let lock = NSLock()
  private var handle: OpaquePointer?

  init?(columns: UInt16 = 84, rows: UInt16 = 40) {
    handle = telemob_terminal_create(columns, rows)
    if handle == nil { return nil }
  }

  deinit {
    close()
  }

  func reset() {
    locked {
      guard let handle else { return }
      telemob_terminal_reset(handle)
    }
  }

  func write(_ data: String) {
    guard !data.isEmpty else { return }
    let bytes = Array(data.utf8)
    locked {
      guard let handle else { return }
      bytes.withUnsafeBytes { buffer in
        guard let base = buffer.bindMemory(to: UInt8.self).baseAddress else { return }
        telemob_terminal_write(handle, base, bytes.count)
      }
    }
  }

  func resize(columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    guard
      columns > 0, columns <= Int(UInt16.max),
      rows > 0, rows <= Int(UInt16.max)
    else { return }
    locked {
      guard let handle else { return }
      _ = telemob_terminal_resize(
        handle,
        UInt16(columns),
        UInt16(rows),
        UInt32(max(1, cellWidth)),
        UInt32(max(1, cellHeight))
      )
    }
  }

  func snapshot() -> Data? {
    locked {
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_snapshot_bytes(handle, &bytes, &length), let bytes else {
        return nil
      }
      defer { telemob_terminal_bytes_free(bytes) }
      return Data(bytes: bytes, count: length)
    }
  }

  func scroll(rows: Int) {
    guard rows != 0 else { return }
    locked {
      guard let handle else { return }
      telemob_terminal_scroll(handle, Int32(clamping: rows))
    }
  }

  func scrollToBottom() {
    locked {
      guard let handle else { return }
      telemob_terminal_scroll_to_bottom(handle)
    }
  }

  func modes() -> Modes? {
    locked {
      guard let handle else { return nil }
      var alternateScreen = false
      var mouseTracking = false
      var bracketedPaste = false
      guard telemob_terminal_modes(
        handle,
        &alternateScreen,
        &mouseTracking,
        &bracketedPaste
      ) else { return nil }
      return Modes(
        alternateScreen: alternateScreen,
        mouseTracking: mouseTracking,
        bracketedPaste: bracketedPaste
      )
    }
  }

  func takePtyWrite() -> String? {
    locked {
      guard let handle else { return nil }
      var bytes: UnsafeMutablePointer<UInt8>?
      var length = 0
      guard telemob_terminal_take_pty_write(handle, &bytes, &length), let bytes else {
        return nil
      }
      defer { telemob_terminal_bytes_free(bytes) }
      guard length > 0 else { return nil }
      return String(decoding: UnsafeBufferPointer(start: bytes, count: length), as: UTF8.self)
    }
  }

  func close() {
    locked {
      guard let handle else { return }
      self.handle = nil
      telemob_terminal_destroy(handle)
    }
  }

  private func locked<Result>(_ operation: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return operation()
  }
}

final class NativeTerminalRegistry {
  static let shared = NativeTerminalRegistry()

  private final class Session {
    let engine = GhosttyTerminalEngine()
    var lastSequence: Int64 = 0
    var pending: [Int64: String] = [:]
    let views = NSHashTable<TeleportTerminalView>.weakObjects()
  }

  private let lock = NSRecursiveLock()
  private var sessions: [String: Session] = [:]

  func prepare(sessionID: String) {
    guard !sessionID.isEmpty else { return }
    locked { _ = session(for: sessionID) }
  }

  func handle(event: [String: Any]) {
    guard let sessionID = event["sessionId"] as? String, !sessionID.isEmpty else { return }
    switch event["type"] as? String {
    case "data":
      let sequence = (event["sequence"] as? NSNumber)?.int64Value ?? 0
      let data = event["data"] as? String ?? ""
      feed(sessionID: sessionID, sequence: sequence, data: data)
    case "closed":
      close(sessionID: sessionID)
    default:
      break
    }
  }

  func handle(replayJSON: String) {
    guard
      let data = replayJSON.data(using: .utf8),
      let replay = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let sessionID = replay["sessionId"] as? String,
      let chunks = replay["chunks"] as? [[String: Any]]
    else { return }

    locked {
      guard let session = session(for: sessionID) else { return }
      if replay["truncated"] as? Bool == true,
        let first = chunks.first,
        let sequence = (first["sequence"] as? NSNumber)?.int64Value,
        sequence > session.lastSequence + 1
      {
        session.engine?.reset()
        session.pending.removeAll()
        session.lastSequence = sequence - 1
      }
      for chunk in chunks {
        enqueue(
          session: session,
          sequence: (chunk["sequence"] as? NSNumber)?.int64Value ?? 0,
          data: chunk["data"] as? String ?? ""
        )
      }
      notifyViews(session)
    }
  }

  func attach(sessionID: String, view: TeleportTerminalView) -> GhosttyTerminalEngine? {
    guard !sessionID.isEmpty else { return nil }
    return locked {
      guard let session = session(for: sessionID) else { return nil }
      session.views.add(view)
      return session.engine
    }
  }

  func detach(sessionID: String, view: TeleportTerminalView) {
    locked { sessions[sessionID]?.views.remove(view) }
  }

  func resize(sessionID: String, columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    locked {
      sessions[sessionID]?.engine?.resize(
        columns: columns,
        rows: rows,
        cellWidth: cellWidth,
        cellHeight: cellHeight
      )
    }
  }

  func scroll(sessionID: String, rows: Int) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.scroll(rows: rows)
      notifyViews(session)
    }
  }

  func scrollToBottom(sessionID: String) {
    locked {
      guard let session = sessions[sessionID] else { return }
      session.engine?.scrollToBottom()
      notifyViews(session)
    }
  }

  func modes(sessionID: String) -> GhosttyTerminalEngine.Modes? {
    locked { sessions[sessionID]?.engine?.modes() }
  }

  func takePtyWrite(sessionID: String) -> String? {
    locked { sessions[sessionID]?.engine?.takePtyWrite() }
  }

  func close(sessionID: String) {
    locked {
      guard let session = sessions.removeValue(forKey: sessionID) else { return }
      notifyViews(session)
      session.engine?.close()
    }
  }

  func closeAll() {
    locked {
      let existing = Array(sessions.values)
      sessions.removeAll()
      existing.forEach { session in
        notifyViews(session)
        session.engine?.close()
      }
    }
  }

  private func feed(sessionID: String, sequence: Int64, data: String) {
    locked {
      guard let session = session(for: sessionID) else { return }
      enqueue(session: session, sequence: sequence, data: data)
      notifyViews(session)
    }
  }

  private func session(for sessionID: String) -> Session? {
    if let session = sessions[sessionID] { return session }
    let created = Session()
    guard created.engine != nil else { return nil }
    sessions[sessionID] = created
    return created
  }

  private func enqueue(session: Session, sequence: Int64, data: String) {
    guard sequence > session.lastSequence, !data.isEmpty else { return }
    session.pending[sequence] = data
    while let next = session.pending.removeValue(forKey: session.lastSequence + 1) {
      session.engine?.write(next)
      session.lastSequence += 1
    }
  }

  private func notifyViews(_ session: Session) {
    session.views.allObjects.forEach { $0.requestRender() }
  }

  private func locked<Result>(_ operation: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return operation()
  }
}

public final class TeleportTerminalView: ExpoView {
  let onDimensions = EventDispatcher()

  var sessionID = "" {
    didSet {
      guard oldValue != sessionID else { return }
      NativeTerminalRegistry.shared.detach(sessionID: oldValue, view: self)
      engine = NativeTerminalRegistry.shared.attach(sessionID: sessionID, view: self)
      columns = 0
      rows = 0
      updateTerminalSize()
      requestRender()
    }
  }

  var fontSize: CGFloat = 12 {
    didSet {
      fontSize = min(32, max(6, fontSize))
      updateFontMetrics()
      updateTerminalSize()
      requestRender()
    }
  }

  private weak var engine: GhosttyTerminalEngine?
  private var font = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
  private var boldFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .bold)
  private var cellWidth: CGFloat = 1
  private var cellHeight: CGFloat = 1
  private var baselineOffset: CGFloat = 1
  private var columns = 0
  private var rows = 0

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isOpaque = true
    clipsToBounds = true
    contentMode = .redraw
    backgroundColor = UIColor(red: 11 / 255, green: 17 / 255, blue: 23 / 255, alpha: 1)
    updateFontMetrics()
  }

  deinit {
    NativeTerminalRegistry.shared.detach(sessionID: sessionID, view: self)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    updateTerminalSize()
  }

  public override func draw(_ rect: CGRect) {
    guard let data = engine?.snapshot(), data.count >= snapshotHeaderSize else {
      UIColor(red: 11 / 255, green: 17 / 255, blue: 23 / 255, alpha: 1).setFill()
      UIRectFill(rect)
      return
    }

    data.withUnsafeBytes { rawBuffer in
      guard let bytes = rawBuffer.bindMemory(to: UInt8.self).baseAddress else { return }
      let snapshotColumns = readU16(bytes, 0)
      let snapshotRows = readU16(bytes, 2)
      let cursorColumn = readU16(bytes, 4)
      let cursorRow = readU16(bytes, 6)
      let cursorVisible = bytes[8] != 0
      let cursorStyle = Int(bytes[9])
      let background = color(bytes, 10)
      let foreground = color(bytes, 13)
      background.setFill()
      UIRectFill(rect)

      let availableCells = (data.count - snapshotHeaderSize) / snapshotCellSize
      let cellCount = min(snapshotColumns * snapshotRows, availableCells)
      for index in 0..<cellCount {
        let offset = snapshotHeaderSize + index * snapshotCellSize
        let column = index % snapshotColumns
        let row = index / snapshotColumns
        let flags = Int(bytes[offset + 6])
        let textLength = min(Int(bytes[offset + 7]), terminalTextCapacity)
        var cellForeground = color(bytes, offset)
        var cellBackground = color(bytes, offset + 3)
        let blockCursor = cursorVisible && cursorStyle == cursorBlock &&
          column == cursorColumn && row == cursorRow
        if blockCursor {
          let originalForeground = cellForeground
          cellForeground = cellBackground
          cellBackground = originalForeground
        }

        let cellRect = CGRect(
          x: CGFloat(column) * cellWidth,
          y: CGFloat(row) * cellHeight,
          width: cellWidth,
          height: cellHeight
        )
        if cellBackground != background || blockCursor {
          cellBackground.setFill()
          UIRectFill(cellRect)
        }
        guard textLength > 0, flags & flagInvisible == 0 else { continue }
        let textData = Data(bytes: bytes + offset + 8, count: textLength)
        guard let text = String(data: textData, encoding: .utf8) else { continue }
        let baseFont = flags & flagBold != 0 ? boldFont : font
        var attributes: [NSAttributedString.Key: Any] = [
          .font: baseFont,
          .foregroundColor: flags & flagFaint != 0
            ? cellForeground.withAlphaComponent(0.65)
            : cellForeground,
        ]
        if flags & flagUnderline != 0 {
          attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        if flags & flagStrikethrough != 0 {
          attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
        }
        if flags & flagItalic != 0,
          let descriptor = baseFont.fontDescriptor.withSymbolicTraits(.traitItalic)
        {
          attributes[.font] = UIFont(descriptor: descriptor, size: fontSize)
        }
        (text as NSString).draw(
          at: CGPoint(x: cellRect.minX, y: cellRect.minY + baselineOffset),
          withAttributes: attributes
        )
      }

      if cursorVisible && cursorStyle != cursorBlock {
        drawCursor(
          column: cursorColumn,
          row: cursorRow,
          style: cursorStyle,
          color: foreground
        )
      }
    }
  }

  func requestRender() {
    DispatchQueue.main.async { [weak self] in self?.setNeedsDisplay() }
  }

  private func updateFontMetrics() {
    font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    boldFont = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .bold)
    cellWidth = max(1, ("M" as NSString).size(withAttributes: [.font: font]).width)
    cellHeight = max(1, ceil(font.lineHeight * 1.08))
    baselineOffset = max(0, (cellHeight - font.lineHeight) / 2)
  }

  private func updateTerminalSize() {
    guard bounds.width > 0, bounds.height > 0 else { return }
    let nextColumns = max(1, Int(floor(bounds.width / cellWidth)))
    let nextRows = max(1, Int(floor(bounds.height / cellHeight)))
    guard nextColumns != columns || nextRows != rows else { return }
    columns = nextColumns
    rows = nextRows
    if !sessionID.isEmpty {
      NativeTerminalRegistry.shared.resize(
        sessionID: sessionID,
        columns: columns,
        rows: rows,
        cellWidth: Int(ceil(cellWidth * contentScaleFactor)),
        cellHeight: Int(ceil(cellHeight * contentScaleFactor))
      )
    }
    onDimensions(["columns": columns, "rows": rows])
  }

  private func drawCursor(column: Int, row: Int, style: Int, color: UIColor) {
    var cursorRect = CGRect(
      x: CGFloat(column) * cellWidth,
      y: CGFloat(row) * cellHeight,
      width: cellWidth,
      height: cellHeight
    )
    color.setFill()
    color.setStroke()
    switch style {
    case cursorBar:
      cursorRect.size.width = 2 / contentScaleFactor
      UIRectFill(cursorRect)
    case cursorUnderline:
      cursorRect.origin.y = cursorRect.maxY - 2 / contentScaleFactor
      cursorRect.size.height = 2 / contentScaleFactor
      UIRectFill(cursorRect)
    default:
      UIRectFrame(cursorRect)
    }
  }

  private func readU16(_ bytes: UnsafePointer<UInt8>, _ offset: Int) -> Int {
    Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
  }

  private func color(_ bytes: UnsafePointer<UInt8>, _ offset: Int) -> UIColor {
    UIColor(
      red: CGFloat(bytes[offset]) / 255,
      green: CGFloat(bytes[offset + 1]) / 255,
      blue: CGFloat(bytes[offset + 2]) / 255,
      alpha: 1
    )
  }

  private let snapshotHeaderSize = 16
  private let terminalTextCapacity = 64
  private let snapshotCellSize = 72
  private let cursorBar = 0
  private let cursorBlock = 1
  private let cursorUnderline = 2
  private let flagBold = 1 << 0
  private let flagItalic = 1 << 1
  private let flagFaint = 1 << 2
  private let flagInvisible = 1 << 5
  private let flagStrikethrough = 1 << 6
  private let flagUnderline = 1 << 7
}
