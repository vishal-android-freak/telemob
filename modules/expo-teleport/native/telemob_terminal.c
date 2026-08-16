#include "telemob_terminal.h"

#include <ghostty/vt.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

struct TelemobTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render_state;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  uint8_t* pty_write;
  size_t pty_write_length;
  size_t pty_write_capacity;
  uint8_t* pending_title;
  size_t pending_title_length;
  bool pending_title_changed;
  uint32_t bell_count;
  uint16_t columns;
  uint16_t rows_count;
  uint32_t cell_width;
  uint32_t cell_height;
  bool mouse_button_pressed;
  TelemobTerminalCell* snapshot_cells;
  size_t snapshot_cell_count;
  uint16_t snapshot_columns;
  uint16_t snapshot_rows;
  uint8_t* snapshot_bytes;
  size_t snapshot_bytes_length;
  uint8_t* search_query;
  size_t search_query_length;
  uint32_t search_row;
  uint16_t search_column;
  bool search_has_match;
  pthread_mutex_t mutex;
};

static const char telemob_xtversion[] = "Telemob 1.0";

static void on_bell(GhosttyTerminal terminal, void* userdata) {
  (void)terminal;
  TelemobTerminal* state = userdata;
  if (state != NULL && state->bell_count < UINT32_MAX) state->bell_count += 1;
}

static void on_title_changed(GhosttyTerminal terminal, void* userdata) {
  TelemobTerminal* state = userdata;
  if (state == NULL) return;
  GhosttyString title = {0};
  if (ghostty_terminal_get(
          terminal,
          GHOSTTY_TERMINAL_DATA_TITLE,
          &title) != GHOSTTY_SUCCESS) {
    return;
  }
  uint8_t* replacement = title.len > 0 ? malloc(title.len) : NULL;
  if (title.len > 0 && replacement == NULL) return;
  if (title.len > 0) memcpy(replacement, title.ptr, title.len);
  free(state->pending_title);
  state->pending_title = replacement;
  state->pending_title_length = title.len;
  state->pending_title_changed = true;
}

static GhosttyString on_xtversion(GhosttyTerminal terminal, void* userdata) {
  (void)terminal;
  (void)userdata;
  return (GhosttyString){
      .ptr = (const uint8_t*)telemob_xtversion,
      .len = sizeof(telemob_xtversion) - 1,
  };
}

static bool on_size(
    GhosttyTerminal terminal,
    void* userdata,
    GhosttySizeReportSize* output) {
  (void)terminal;
  TelemobTerminal* state = userdata;
  if (state == NULL || output == NULL) return false;
  *output = (GhosttySizeReportSize){
      .rows = state->rows_count,
      .columns = state->columns,
      .cell_width = state->cell_width,
      .cell_height = state->cell_height,
  };
  return true;
}

static bool on_color_scheme(
    GhosttyTerminal terminal,
    void* userdata,
    GhosttyColorScheme* output) {
  (void)terminal;
  (void)userdata;
  if (output == NULL) return false;
  *output = GHOSTTY_COLOR_SCHEME_DARK;
  return true;
}

static bool on_device_attributes(
    GhosttyTerminal terminal,
    void* userdata,
    GhosttyDeviceAttributes* output) {
  (void)terminal;
  (void)userdata;
  if (output == NULL) return false;
  memset(output, 0, sizeof(*output));
  output->primary.conformance_level = GHOSTTY_DA_CONFORMANCE_VT420;
  output->primary.features[0] = GHOSTTY_DA_FEATURE_SELECTIVE_ERASE;
  output->primary.features[1] = GHOSTTY_DA_FEATURE_WINDOWING;
  output->primary.features[2] = GHOSTTY_DA_FEATURE_ANSI_COLOR;
  output->primary.num_features = 3;
  output->secondary.device_type = GHOSTTY_DA_DEVICE_TYPE_VT220;
  output->secondary.firmware_version = 100;
  return true;
}

static void on_write_pty(
    GhosttyTerminal terminal,
    void* userdata,
    const uint8_t* data,
    size_t length) {
  (void)terminal;
  TelemobTerminal* state = userdata;
  if (state == NULL || data == NULL || length == 0) return;
  if (length > SIZE_MAX - state->pty_write_length) return;
  const size_t required = state->pty_write_length + length;
  if (required > state->pty_write_capacity) {
    size_t capacity = state->pty_write_capacity == 0 ? 64 : state->pty_write_capacity;
    while (capacity < required && capacity <= SIZE_MAX / 2) capacity *= 2;
    if (capacity < required) capacity = required;
    uint8_t* resized = realloc(state->pty_write, capacity);
    if (resized == NULL) return;
    state->pty_write = resized;
    state->pty_write_capacity = capacity;
  }
  memcpy(state->pty_write + state->pty_write_length, data, length);
  state->pty_write_length = required;
}

static void clear_snapshot(TelemobTerminalSnapshot* snapshot) {
  if (snapshot != NULL) memset(snapshot, 0, sizeof(*snapshot));
}

static GhosttyColorRgb resolved_color(
    GhosttyStyleColor color,
    const GhosttyRenderStateColors* colors,
    GhosttyColorRgb fallback) {
  switch (color.tag) {
    case GHOSTTY_STYLE_COLOR_RGB:
      return color.value.rgb;
    case GHOSTTY_STYLE_COLOR_PALETTE:
      return colors->palette[color.value.palette];
    default:
      return fallback;
  }
}

static size_t append_utf8(char* output, size_t capacity, uint32_t codepoint) {
  if (codepoint <= 0x7f && capacity >= 1) {
    output[0] = (char)codepoint;
    return 1;
  }
  if (codepoint <= 0x7ff && capacity >= 2) {
    output[0] = (char)(0xc0 | (codepoint >> 6));
    output[1] = (char)(0x80 | (codepoint & 0x3f));
    return 2;
  }
  if (codepoint <= 0xffff && capacity >= 3) {
    output[0] = (char)(0xe0 | (codepoint >> 12));
    output[1] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    output[2] = (char)(0x80 | (codepoint & 0x3f));
    return 3;
  }
  if (codepoint <= 0x10ffff && capacity >= 4) {
    output[0] = (char)(0xf0 | (codepoint >> 18));
    output[1] = (char)(0x80 | ((codepoint >> 12) & 0x3f));
    output[2] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
    output[3] = (char)(0x80 | (codepoint & 0x3f));
    return 4;
  }
  return 0;
}

TelemobTerminal* telemob_terminal_create(uint16_t columns, uint16_t rows) {
  if (columns == 0 || rows == 0) return NULL;
  TelemobTerminal* result = calloc(1, sizeof(*result));
  if (result == NULL) return NULL;
  if (pthread_mutex_init(&result->mutex, NULL) != 0) {
    free(result);
    return NULL;
  }
  GhosttyTerminalOptions options = {
      .cols = columns,
      .rows = rows,
      .max_scrollback = 10000,
  };
  if (ghostty_terminal_new(NULL, &result->terminal, options) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(NULL, &result->render_state) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(NULL, &result->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(NULL, &result->cells) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(NULL, &result->key_encoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(NULL, &result->key_event) != GHOSTTY_SUCCESS ||
      ghostty_mouse_encoder_new(NULL, &result->mouse_encoder) != GHOSTTY_SUCCESS ||
      ghostty_mouse_event_new(NULL, &result->mouse_event) != GHOSTTY_SUCCESS) {
    telemob_terminal_destroy(result);
    return NULL;
  }
  result->columns = columns;
  result->rows_count = rows;
  result->cell_width = 1;
  result->cell_height = 1;
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_USERDATA,
      result);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      (const void*)on_write_pty);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_BELL,
      (const void*)on_bell);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_TITLE_CHANGED,
      (const void*)on_title_changed);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_XTVERSION,
      (const void*)on_xtversion);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_SIZE,
      (const void*)on_size);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_COLOR_SCHEME,
      (const void*)on_color_scheme);
  ghostty_terminal_set(
      result->terminal,
      GHOSTTY_TERMINAL_OPT_DEVICE_ATTRIBUTES,
      (const void*)on_device_attributes);
  return result;
}

void telemob_terminal_destroy(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  if (terminal->mouse_event != NULL) ghostty_mouse_event_free(terminal->mouse_event);
  if (terminal->mouse_encoder != NULL) ghostty_mouse_encoder_free(terminal->mouse_encoder);
  if (terminal->key_event != NULL) ghostty_key_event_free(terminal->key_event);
  if (terminal->key_encoder != NULL) ghostty_key_encoder_free(terminal->key_encoder);
  if (terminal->cells != NULL) ghostty_render_state_row_cells_free(terminal->cells);
  if (terminal->rows != NULL) ghostty_render_state_row_iterator_free(terminal->rows);
  if (terminal->render_state != NULL) ghostty_render_state_free(terminal->render_state);
  if (terminal->terminal != NULL) ghostty_terminal_free(terminal->terminal);
  free(terminal->snapshot_cells);
  free(terminal->snapshot_bytes);
  free(terminal->search_query);
  free(terminal->pty_write);
  free(terminal->pending_title);
  pthread_mutex_destroy(&terminal->mutex);
  free(terminal);
}

void telemob_terminal_reset(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_terminal_reset(terminal->terminal);
  ghostty_mouse_encoder_reset(terminal->mouse_encoder);
  terminal->mouse_button_pressed = false;
  free(terminal->search_query);
  terminal->search_query = NULL;
  terminal->search_query_length = 0;
  terminal->search_has_match = false;
  terminal->pty_write_length = 0;
  free(terminal->pending_title);
  terminal->pending_title = NULL;
  terminal->pending_title_length = 0;
  terminal->pending_title_changed = false;
  terminal->bell_count = 0;
  pthread_mutex_unlock(&terminal->mutex);
}

void telemob_terminal_write(TelemobTerminal* terminal, const uint8_t* bytes, size_t length) {
  if (terminal == NULL || bytes == NULL || length == 0) return;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_terminal_vt_write(terminal->terminal, bytes, length);
  pthread_mutex_unlock(&terminal->mutex);
}

bool telemob_terminal_resize(
    TelemobTerminal* terminal,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height) {
  if (terminal == NULL || columns == 0 || rows == 0) return false;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyResult result = ghostty_terminal_resize(
      terminal->terminal,
      columns,
      rows,
      cell_width,
      cell_height);
  if (result == GHOSTTY_SUCCESS) {
    terminal->columns = columns;
    terminal->rows_count = rows;
    terminal->cell_width = cell_width;
    terminal->cell_height = cell_height;
  }
  pthread_mutex_unlock(&terminal->mutex);
  return result == GHOSTTY_SUCCESS;
}

static void fill_cell(
    GhosttyRenderStateRowCells cells,
    const GhosttyRenderStateColors* colors,
    TelemobTerminalCell* output) {
  GhosttyStyle style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  GhosttyColorRgb foreground = colors->foreground;
  GhosttyColorRgb background = colors->background;
  GhosttyColorRgb underline = colors->foreground;
  bool underline_has_color = false;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
          &style) == GHOSTTY_SUCCESS) {
    foreground = resolved_color(style.fg_color, colors, foreground);
    background = resolved_color(style.bg_color, colors, background);
    underline_has_color = style.underline_color.tag != GHOSTTY_STYLE_COLOR_NONE;
    underline = resolved_color(style.underline_color, colors, foreground);
    if (style.bold) output->flags |= TELEMOB_TERMINAL_CELL_BOLD;
    if (style.italic) output->flags |= TELEMOB_TERMINAL_CELL_ITALIC;
    if (style.faint) output->flags |= TELEMOB_TERMINAL_CELL_FAINT;
    if (style.blink) output->flags |= TELEMOB_TERMINAL_CELL_BLINK;
    if (style.inverse) output->flags |= TELEMOB_TERMINAL_CELL_INVERSE;
    if (style.invisible) output->flags |= TELEMOB_TERMINAL_CELL_INVISIBLE;
    if (style.strikethrough) output->flags |= TELEMOB_TERMINAL_CELL_STRIKETHROUGH;
    if (style.overline) output->flags |= TELEMOB_TERMINAL_CELL_OVERLINE;
    if (style.underline != GHOSTTY_SGR_UNDERLINE_NONE) {
      output->flags |= TELEMOB_TERMINAL_CELL_UNDERLINE;
      output->underline_style = (uint8_t)style.underline;
    }
  }

  GhosttyColorRgb explicit_color;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
          &explicit_color) == GHOSTTY_SUCCESS) {
    foreground = explicit_color;
  }
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
          &explicit_color) == GHOSTTY_SUCCESS) {
    background = explicit_color;
  }
  if (style.inverse) {
    GhosttyColorRgb swap = foreground;
    foreground = background;
    background = swap;
  }
  if (!underline_has_color) underline = foreground;
  output->foreground_red = foreground.r;
  output->foreground_green = foreground.g;
  output->foreground_blue = foreground.b;
  output->background_red = background.r;
  output->background_green = background.g;
  output->background_blue = background.b;
  output->underline_red = underline.r;
  output->underline_green = underline.g;
  output->underline_blue = underline.b;

  uint32_t grapheme_length = 0;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN,
          &grapheme_length) != GHOSTTY_SUCCESS ||
      grapheme_length == 0) {
    return;
  }
  uint32_t stack_codepoints[16];
  uint32_t* codepoints = stack_codepoints;
  if (grapheme_length > 16) codepoints = calloc(grapheme_length, sizeof(*codepoints));
  if (codepoints == NULL) return;
  if (ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF,
          codepoints) == GHOSTTY_SUCCESS) {
    size_t written = 0;
    for (uint32_t index = 0; index < grapheme_length; index += 1) {
      written += append_utf8(
          output->text + written,
          TELEMOB_TERMINAL_CELL_TEXT_CAPACITY - written,
          codepoints[index]);
      if (written >= TELEMOB_TERMINAL_CELL_TEXT_CAPACITY) break;
    }
    output->text_length = (uint8_t)written;
  }
  if (codepoints != stack_codepoints) free(codepoints);
}

static void write_u16(uint8_t* output, uint16_t value);
static void write_u64(uint8_t* output, uint64_t value);

static void serialize_cell(const TelemobTerminalCell* cell, uint8_t* target) {
  memset(target, 0, TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE);
  target[0] = cell->foreground_red;
  target[1] = cell->foreground_green;
  target[2] = cell->foreground_blue;
  target[3] = cell->background_red;
  target[4] = cell->background_green;
  target[5] = cell->background_blue;
  write_u16(target + 6, cell->flags);
  target[8] = cell->underline_style;
  target[9] = cell->underline_red;
  target[10] = cell->underline_green;
  target[11] = cell->underline_blue;
  target[12] = cell->text_length;
  memcpy(target + 13, cell->text, cell->text_length);
}

static void serialize_header(
    const TelemobTerminalSnapshot* snapshot,
    uint8_t* bytes) {
  memset(bytes, 0, TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE);
  write_u16(bytes + 0, snapshot->columns);
  write_u16(bytes + 2, snapshot->rows);
  write_u16(bytes + 4, snapshot->cursor_column);
  write_u16(bytes + 6, snapshot->cursor_row);
  bytes[8] = snapshot->cursor_visible;
  bytes[9] = snapshot->cursor_style;
  bytes[10] = snapshot->background_red;
  bytes[11] = snapshot->background_green;
  bytes[12] = snapshot->background_blue;
  bytes[13] = snapshot->foreground_red;
  bytes[14] = snapshot->foreground_green;
  bytes[15] = snapshot->foreground_blue;
  bytes[16] = snapshot->cursor_blinking;
  bytes[17] = snapshot->cursor_red;
  bytes[18] = snapshot->cursor_green;
  bytes[19] = snapshot->cursor_blue;
  write_u64(bytes + 20, snapshot->scrollbar_total);
  write_u64(bytes + 28, snapshot->scrollbar_offset);
  write_u64(bytes + 36, snapshot->scrollbar_length);
}

static bool prepare_snapshot_locked(
    TelemobTerminal* terminal,
    TelemobTerminalSnapshot* snapshot) {
  clear_snapshot(snapshot);
  if (ghostty_render_state_update(terminal->render_state, terminal->terminal) != GHOSTTY_SUCCESS) {
    return false;
  }
  GhosttyRenderStateDirty dirty = GHOSTTY_RENDER_STATE_DIRTY_FULL;
  if (ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_DIRTY,
          &dirty) != GHOSTTY_SUCCESS) {
    return false;
  }

  // A cursor-only control sequence can move the hardware cursor without
  // dirtying any text row. We still need to refresh and serialize the snapshot
  // header in that case; the cached cells below can remain untouched.

  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  if (ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_COLS,
          &snapshot->columns) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_ROWS,
          &snapshot->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_colors_get(terminal->render_state, &colors) != GHOSTTY_SUCCESS) {
    return false;
  }

  const size_t cell_count = (size_t)snapshot->columns * (size_t)snapshot->rows;
  const bool dimensions_changed =
      terminal->snapshot_columns != snapshot->columns ||
      terminal->snapshot_rows != snapshot->rows ||
      terminal->snapshot_cell_count != cell_count;
  if (dimensions_changed) {
    if (cell_count >
        (SIZE_MAX - TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE) /
            TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE) {
      return false;
    }
    const size_t bytes_length = TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE +
        cell_count * TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE;
    TelemobTerminalCell* replacement_cells =
        calloc(cell_count, sizeof(*replacement_cells));
    uint8_t* replacement_bytes = calloc(bytes_length, 1);
    if (replacement_cells == NULL || replacement_bytes == NULL) {
      free(replacement_cells);
      free(replacement_bytes);
      return false;
    }
    free(terminal->snapshot_cells);
    free(terminal->snapshot_bytes);
    terminal->snapshot_cells = replacement_cells;
    terminal->snapshot_cell_count = cell_count;
    terminal->snapshot_columns = snapshot->columns;
    terminal->snapshot_rows = snapshot->rows;
    terminal->snapshot_bytes = replacement_bytes;
    terminal->snapshot_bytes_length = bytes_length;
  }
  const bool full_refresh =
      dimensions_changed || dirty == GHOSTTY_RENDER_STATE_DIRTY_FULL;

  snapshot->background_red = colors.background.r;
  snapshot->background_green = colors.background.g;
  snapshot->background_blue = colors.background.b;
  snapshot->foreground_red = colors.foreground.r;
  snapshot->foreground_green = colors.foreground.g;
  snapshot->foreground_blue = colors.foreground.b;
  GhosttyTerminalScrollbar scrollbar = {0};
  if (ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_SCROLLBAR,
          &scrollbar) == GHOSTTY_SUCCESS) {
    snapshot->scrollbar_total = scrollbar.total;
    snapshot->scrollbar_offset = scrollbar.offset;
    snapshot->scrollbar_length = scrollbar.len;
  }
  snapshot->cell_count = cell_count;
  snapshot->cells = terminal->snapshot_cells;

  bool cursor_visible = false;
  bool cursor_in_viewport = false;
  bool cursor_blinking = false;
  bool cursor_wide_tail = false;
  GhosttyRenderStateCursorVisualStyle cursor_style = GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE,
      &cursor_visible);
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
      &cursor_in_viewport);
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
      &cursor_style);
  ghostty_render_state_get(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING,
      &cursor_blinking);
  snapshot->cursor_visible = cursor_visible && cursor_in_viewport;
  snapshot->cursor_style = (uint8_t)cursor_style;
  snapshot->cursor_blinking = cursor_blinking;
  snapshot->cursor_red = colors.cursor_has_value ? colors.cursor.r : colors.foreground.r;
  snapshot->cursor_green = colors.cursor_has_value ? colors.cursor.g : colors.foreground.g;
  snapshot->cursor_blue = colors.cursor_has_value ? colors.cursor.b : colors.foreground.b;
  if (snapshot->cursor_visible) {
    ghostty_render_state_get(
        terminal->render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
        &snapshot->cursor_column);
    ghostty_render_state_get(
        terminal->render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
        &snapshot->cursor_row);
    ghostty_render_state_get(
        terminal->render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_WIDE_TAIL,
        &cursor_wide_tail);
    if (cursor_wide_tail && snapshot->cursor_column > 0) snapshot->cursor_column -= 1;
  }
  serialize_header(snapshot, terminal->snapshot_bytes);

  if (ghostty_render_state_get(
          terminal->render_state,
          GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
          &terminal->rows) != GHOSTTY_SUCCESS) {
    return false;
  }

  size_t row_index = 0;
  while (row_index < snapshot->rows && ghostty_render_state_row_iterator_next(terminal->rows)) {
    bool row_dirty = full_refresh;
    if (!row_dirty) {
      if (ghostty_render_state_row_get(
              terminal->rows,
              GHOSTTY_RENDER_STATE_ROW_DATA_DIRTY,
              &row_dirty) != GHOSTTY_SUCCESS) {
        row_dirty = true;
      }
    }
    if (!row_dirty) {
      row_index += 1;
      continue;
    }

    TelemobTerminalCell* row_cells =
        &terminal->snapshot_cells[row_index * snapshot->columns];
    memset(row_cells, 0, snapshot->columns * sizeof(*row_cells));
    GhosttyRenderStateRowSelection selection =
        GHOSTTY_INIT_SIZED(GhosttyRenderStateRowSelection);
    const bool row_selected = ghostty_render_state_row_get(
        terminal->rows,
        GHOSTTY_RENDER_STATE_ROW_DATA_SELECTION,
        &selection) == GHOSTTY_SUCCESS;
    if (ghostty_render_state_row_get(
            terminal->rows,
            GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
            &terminal->cells) != GHOSTTY_SUCCESS) {
      return false;
    }
    size_t column_index = 0;
    while (column_index < snapshot->columns && ghostty_render_state_row_cells_next(terminal->cells)) {
      fill_cell(
          terminal->cells,
          &colors,
          &row_cells[column_index]);
      if (row_selected && column_index >= selection.start_x &&
          column_index <= selection.end_x) {
        row_cells[column_index].flags |= TELEMOB_TERMINAL_CELL_SELECTED;
      }
      column_index += 1;
    }
    for (column_index = 0; column_index < snapshot->columns; column_index += 1) {
      serialize_cell(
          &row_cells[column_index],
          terminal->snapshot_bytes + TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE +
              (row_index * snapshot->columns + column_index) *
                  TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE);
    }
    const bool row_clean = false;
    ghostty_render_state_row_set(
        terminal->rows,
        GHOSTTY_RENDER_STATE_ROW_OPTION_DIRTY,
        &row_clean);
    row_index += 1;
  }
  const GhosttyRenderStateDirty clean = GHOSTTY_RENDER_STATE_DIRTY_FALSE;
  ghostty_render_state_set(
      terminal->render_state,
      GHOSTTY_RENDER_STATE_OPTION_DIRTY,
      &clean);
  return true;
}

bool telemob_terminal_snapshot(TelemobTerminal* terminal, TelemobTerminalSnapshot* snapshot) {
  if (terminal == NULL || snapshot == NULL) return false;
  clear_snapshot(snapshot);
  pthread_mutex_lock(&terminal->mutex);
  TelemobTerminalSnapshot prepared;
  if (!prepare_snapshot_locked(terminal, &prepared)) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  TelemobTerminalCell* cells = malloc(prepared.cell_count * sizeof(*cells));
  if (cells == NULL) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  memcpy(cells, prepared.cells, prepared.cell_count * sizeof(*cells));
  *snapshot = prepared;
  snapshot->cells = cells;
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

void telemob_terminal_snapshot_free(TelemobTerminalSnapshot* snapshot) {
  if (snapshot == NULL) return;
  free(snapshot->cells);
  clear_snapshot(snapshot);
}

static void write_u16(uint8_t* output, uint16_t value) {
  output[0] = (uint8_t)(value & 0xff);
  output[1] = (uint8_t)((value >> 8) & 0xff);
}

static void write_u64(uint8_t* output, uint64_t value) {
  for (size_t index = 0; index < 8; index += 1) {
    output[index] = (uint8_t)((value >> (index * 8)) & 0xff);
  }
}

bool telemob_terminal_snapshot_bytes(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;

  TelemobTerminalSnapshot snapshot;
  pthread_mutex_lock(&terminal->mutex);
  if (!prepare_snapshot_locked(terminal, &snapshot)) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  const size_t length = terminal->snapshot_bytes_length;
  uint8_t* bytes = malloc(length);
  if (bytes == NULL) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  memcpy(bytes, terminal->snapshot_bytes, length);

  pthread_mutex_unlock(&terminal->mutex);
  *output = bytes;
  *output_length = length;
  return true;
}

void telemob_terminal_bytes_free(uint8_t* bytes) {
  free(bytes);
}

bool telemob_terminal_modes(
    TelemobTerminal* terminal,
    bool* alternate_screen,
    bool* mouse_tracking,
    bool* bracketed_paste) {
  if (terminal == NULL || alternate_screen == NULL || mouse_tracking == NULL ||
      bracketed_paste == NULL) {
    return false;
  }
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  const bool success =
      ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN,
          &screen) == GHOSTTY_SUCCESS &&
      ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING,
          mouse_tracking) == GHOSTTY_SUCCESS &&
      ghostty_terminal_mode_get(
          terminal->terminal,
          GHOSTTY_MODE_BRACKETED_PASTE,
          bracketed_paste) == GHOSTTY_SUCCESS;
  *alternate_screen = screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE;
  pthread_mutex_unlock(&terminal->mutex);
  return success;
}

bool telemob_terminal_take_pty_write(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  if (terminal->pty_write_length == 0) {
    pthread_mutex_unlock(&terminal->mutex);
    return true;
  }
  *output = terminal->pty_write;
  *output_length = terminal->pty_write_length;
  terminal->pty_write = NULL;
  terminal->pty_write_length = 0;
  terminal->pty_write_capacity = 0;
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

bool telemob_terminal_take_title(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  if (!terminal->pending_title_changed) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  *output = terminal->pending_title;
  *output_length = terminal->pending_title_length;
  terminal->pending_title = NULL;
  terminal->pending_title_length = 0;
  terminal->pending_title_changed = false;
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

uint32_t telemob_terminal_take_bell_count(TelemobTerminal* terminal) {
  if (terminal == NULL) return 0;
  pthread_mutex_lock(&terminal->mutex);
  const uint32_t result = terminal->bell_count;
  terminal->bell_count = 0;
  pthread_mutex_unlock(&terminal->mutex);
  return result;
}

static GhosttyKey key_from_code(TelemobTerminalKey key) {
  switch (key) {
    case TELEMOB_TERMINAL_KEY_INTERRUPT: return GHOSTTY_KEY_C;
    case TELEMOB_TERMINAL_KEY_ESCAPE: return GHOSTTY_KEY_ESCAPE;
    case TELEMOB_TERMINAL_KEY_TAB: return GHOSTTY_KEY_TAB;
    case TELEMOB_TERMINAL_KEY_BACKSPACE: return GHOSTTY_KEY_BACKSPACE;
    case TELEMOB_TERMINAL_KEY_ENTER: return GHOSTTY_KEY_ENTER;
    case TELEMOB_TERMINAL_KEY_INSERT: return GHOSTTY_KEY_INSERT;
    case TELEMOB_TERMINAL_KEY_DELETE: return GHOSTTY_KEY_DELETE;
    case TELEMOB_TERMINAL_KEY_PAGE_UP: return GHOSTTY_KEY_PAGE_UP;
    case TELEMOB_TERMINAL_KEY_PAGE_DOWN: return GHOSTTY_KEY_PAGE_DOWN;
    case TELEMOB_TERMINAL_KEY_ARROW_UP: return GHOSTTY_KEY_ARROW_UP;
    case TELEMOB_TERMINAL_KEY_ARROW_DOWN: return GHOSTTY_KEY_ARROW_DOWN;
    case TELEMOB_TERMINAL_KEY_ARROW_LEFT: return GHOSTTY_KEY_ARROW_LEFT;
    case TELEMOB_TERMINAL_KEY_ARROW_RIGHT: return GHOSTTY_KEY_ARROW_RIGHT;
    case TELEMOB_TERMINAL_KEY_HOME: return GHOSTTY_KEY_HOME;
    case TELEMOB_TERMINAL_KEY_END: return GHOSTTY_KEY_END;
    case TELEMOB_TERMINAL_KEY_F1: return GHOSTTY_KEY_F1;
    case TELEMOB_TERMINAL_KEY_F2: return GHOSTTY_KEY_F2;
    case TELEMOB_TERMINAL_KEY_F3: return GHOSTTY_KEY_F3;
    case TELEMOB_TERMINAL_KEY_F4: return GHOSTTY_KEY_F4;
    case TELEMOB_TERMINAL_KEY_F5: return GHOSTTY_KEY_F5;
    case TELEMOB_TERMINAL_KEY_F6: return GHOSTTY_KEY_F6;
    case TELEMOB_TERMINAL_KEY_F7: return GHOSTTY_KEY_F7;
    case TELEMOB_TERMINAL_KEY_F8: return GHOSTTY_KEY_F8;
    case TELEMOB_TERMINAL_KEY_F9: return GHOSTTY_KEY_F9;
    case TELEMOB_TERMINAL_KEY_F10: return GHOSTTY_KEY_F10;
    case TELEMOB_TERMINAL_KEY_F11: return GHOSTTY_KEY_F11;
    case TELEMOB_TERMINAL_KEY_F12: return GHOSTTY_KEY_F12;
    default: return GHOSTTY_KEY_UNIDENTIFIED;
  }
}

static uint32_t first_utf8_codepoint(const uint8_t* text, size_t length) {
  if (text == NULL || length == 0) return 0;
  const uint8_t first = text[0];
  if (first < 0x80) return first;
  if ((first & 0xe0) == 0xc0 && length >= 2) {
    return ((uint32_t)(first & 0x1f) << 6) | (uint32_t)(text[1] & 0x3f);
  }
  if ((first & 0xf0) == 0xe0 && length >= 3) {
    return ((uint32_t)(first & 0x0f) << 12) |
        ((uint32_t)(text[1] & 0x3f) << 6) |
        (uint32_t)(text[2] & 0x3f);
  }
  if ((first & 0xf8) == 0xf0 && length >= 4) {
    return ((uint32_t)(first & 0x07) << 18) |
        ((uint32_t)(text[1] & 0x3f) << 12) |
        ((uint32_t)(text[2] & 0x3f) << 6) |
        (uint32_t)(text[3] & 0x3f);
  }
  return 0;
}

static GhosttyKey key_from_text(const uint8_t* text, size_t length) {
  const uint32_t codepoint = first_utf8_codepoint(text, length);
  if (codepoint >= 'a' && codepoint <= 'z') {
    return (GhosttyKey)(GHOSTTY_KEY_A + codepoint - 'a');
  }
  if (codepoint >= 'A' && codepoint <= 'Z') {
    return (GhosttyKey)(GHOSTTY_KEY_A + codepoint - 'A');
  }
  if (codepoint >= '1' && codepoint <= '9') {
    return (GhosttyKey)(GHOSTTY_KEY_DIGIT_1 + codepoint - '1');
  }
  switch (codepoint) {
    case '0': return GHOSTTY_KEY_DIGIT_0;
    case ' ': return GHOSTTY_KEY_SPACE;
    case '`': case '~': return GHOSTTY_KEY_BACKQUOTE;
    case '\\': case '|': return GHOSTTY_KEY_BACKSLASH;
    case '[': case '{': return GHOSTTY_KEY_BRACKET_LEFT;
    case ']': case '}': return GHOSTTY_KEY_BRACKET_RIGHT;
    case ',': case '<': return GHOSTTY_KEY_COMMA;
    case '=': case '+': return GHOSTTY_KEY_EQUAL;
    case '-': case '_': return GHOSTTY_KEY_MINUS;
    case '.': case '>': return GHOSTTY_KEY_PERIOD;
    case '\'': case '"': return GHOSTTY_KEY_QUOTE;
    case ';': case ':': return GHOSTTY_KEY_SEMICOLON;
    case '/': case '?': return GHOSTTY_KEY_SLASH;
    default: return GHOSTTY_KEY_UNIDENTIFIED;
  }
}

static bool copy_encoded_bytes(
    GhosttyResult result,
    const char* stack,
    size_t written,
    uint8_t** output,
    size_t* output_length) {
  if (result != GHOSTTY_SUCCESS) return false;
  if (written == 0) return true;
  uint8_t* bytes = malloc(written);
  if (bytes == NULL) return false;
  memcpy(bytes, stack, written);
  *output = bytes;
  *output_length = written;
  return true;
}

bool telemob_terminal_encode_key(
    TelemobTerminal* terminal,
    int32_t key_value,
    const uint8_t* text,
    size_t text_length,
    uint16_t modifiers,
    int32_t action,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL ||
      key_value < TELEMOB_TERMINAL_KEY_TEXT || key_value > TELEMOB_TERMINAL_KEY_F12 ||
      action < TELEMOB_TERMINAL_KEY_ACTION_RELEASE ||
      action > TELEMOB_TERMINAL_KEY_ACTION_REPEAT) {
    return false;
  }
  const TelemobTerminalKey key = (TelemobTerminalKey)key_value;
  static const uint8_t interrupt_text[] = {'c'};
  const uint8_t* event_text = text;
  size_t event_text_length = text_length;
  if (key == TELEMOB_TERMINAL_KEY_INTERRUPT && event_text_length == 0) {
    event_text = interrupt_text;
    event_text_length = sizeof(interrupt_text);
  }
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_key_encoder_setopt_from_terminal(terminal->key_encoder, terminal->terminal);
  ghostty_key_event_set_action(terminal->key_event, (GhosttyKeyAction)action);
  GhosttyKey ghostty_key = key == TELEMOB_TERMINAL_KEY_TEXT
      ? key_from_text(event_text, event_text_length)
      : key_from_code(key);
  if (key == TELEMOB_TERMINAL_KEY_INTERRUPT) modifiers |= TELEMOB_TERMINAL_MOD_CTRL;
  ghostty_key_event_set_key(terminal->key_event, ghostty_key);
  ghostty_key_event_set_mods(terminal->key_event, (GhosttyMods)modifiers);
  ghostty_key_event_set_consumed_mods(terminal->key_event, 0);
  ghostty_key_event_set_composing(terminal->key_event, false);
  ghostty_key_event_set_utf8(
      terminal->key_event,
      event_text_length == 0 ? NULL : (const char*)event_text,
      event_text_length);
  ghostty_key_event_set_unshifted_codepoint(
      terminal->key_event,
      first_utf8_codepoint(event_text, event_text_length));
  char encoded[128];
  size_t written = 0;
  GhosttyResult result = ghostty_key_encoder_encode(
      terminal->key_encoder,
      terminal->key_event,
      encoded,
      sizeof(encoded),
      &written);
  pthread_mutex_unlock(&terminal->mutex);
  return copy_encoded_bytes(result, encoded, written, output, output_length);
}

bool telemob_terminal_encode_mouse(
    TelemobTerminal* terminal,
    int32_t action,
    int32_t button,
    uint16_t modifiers,
    uint16_t column,
    uint16_t row,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL ||
      action < TELEMOB_TERMINAL_MOUSE_PRESS ||
      action > TELEMOB_TERMINAL_MOUSE_MOTION ||
      button < TELEMOB_TERMINAL_MOUSE_NONE ||
      button > TELEMOB_TERMINAL_MOUSE_WHEEL_DOWN ||
      column == 0 || row == 0) {
    return false;
  }
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_mouse_encoder_setopt_from_terminal(terminal->mouse_encoder, terminal->terminal);
  const GhosttyMouseEncoderSize size = {
      .size = sizeof(GhosttyMouseEncoderSize),
      .screen_width = (uint32_t)terminal->columns * terminal->cell_width,
      .screen_height = (uint32_t)terminal->rows_count * terminal->cell_height,
      .cell_width = terminal->cell_width,
      .cell_height = terminal->cell_height,
  };
  ghostty_mouse_encoder_setopt(
      terminal->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
      &size);
  ghostty_mouse_encoder_setopt(
      terminal->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
      &terminal->mouse_button_pressed);
  const bool track_last_cell = true;
  ghostty_mouse_encoder_setopt(
      terminal->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
      &track_last_cell);
  ghostty_mouse_event_set_action(terminal->mouse_event, (GhosttyMouseAction)action);
  if (button == TELEMOB_TERMINAL_MOUSE_NONE) {
    ghostty_mouse_event_clear_button(terminal->mouse_event);
  } else {
    ghostty_mouse_event_set_button(terminal->mouse_event, (GhosttyMouseButton)button);
  }
  ghostty_mouse_event_set_mods(terminal->mouse_event, (GhosttyMods)modifiers);
  ghostty_mouse_event_set_position(
      terminal->mouse_event,
      (GhosttyMousePosition){
          .x = ((float)column - 0.5f) * (float)terminal->cell_width,
          .y = ((float)row - 0.5f) * (float)terminal->cell_height,
      });
  char encoded[128];
  size_t written = 0;
  GhosttyResult result = ghostty_mouse_encoder_encode(
      terminal->mouse_encoder,
      terminal->mouse_event,
      encoded,
      sizeof(encoded),
      &written);
  if (button == TELEMOB_TERMINAL_MOUSE_LEFT ||
      button == TELEMOB_TERMINAL_MOUSE_RIGHT ||
      button == TELEMOB_TERMINAL_MOUSE_MIDDLE) {
    terminal->mouse_button_pressed = action != TELEMOB_TERMINAL_MOUSE_RELEASE;
  }
  pthread_mutex_unlock(&terminal->mutex);
  return copy_encoded_bytes(result, encoded, written, output, output_length);
}

bool telemob_terminal_encode_focus(
    TelemobTerminal* terminal,
    bool focused,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  bool reporting = false;
  const bool mode_ok = ghostty_terminal_mode_get(
      terminal->terminal,
      GHOSTTY_MODE_FOCUS_EVENT,
      &reporting) == GHOSTTY_SUCCESS;
  char encoded[8];
  size_t written = 0;
  const GhosttyResult result = mode_ok && reporting
      ? ghostty_focus_encode(
            focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
            encoded,
            sizeof(encoded),
            &written)
      : GHOSTTY_SUCCESS;
  pthread_mutex_unlock(&terminal->mutex);
  return copy_encoded_bytes(result, encoded, written, output, output_length);
}

bool telemob_terminal_encode_paste(
    TelemobTerminal* terminal,
    const uint8_t* data,
    size_t data_length,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL ||
      (data == NULL && data_length > 0)) {
    return false;
  }
  *output = NULL;
  *output_length = 0;
  char* mutable_data = NULL;
  if (data_length > 0) {
    mutable_data = malloc(data_length);
    if (mutable_data == NULL) return false;
    memcpy(mutable_data, data, data_length);
  }
  pthread_mutex_lock(&terminal->mutex);
  bool bracketed = false;
  ghostty_terminal_mode_get(
      terminal->terminal,
      GHOSTTY_MODE_BRACKETED_PASTE,
      &bracketed);
  size_t required = 0;
  GhosttyResult result = ghostty_paste_encode(
      mutable_data,
      data_length,
      bracketed,
      NULL,
      0,
      &required);
  uint8_t* encoded = required > 0 ? malloc(required) : NULL;
  if (result == GHOSTTY_OUT_OF_SPACE && encoded != NULL) {
    result = ghostty_paste_encode(
        mutable_data,
        data_length,
        bracketed,
        (char*)encoded,
        required,
        &required);
  }
  pthread_mutex_unlock(&terminal->mutex);
  free(mutable_data);
  if (result != GHOSTTY_SUCCESS) {
    free(encoded);
    return false;
  }
  *output = encoded;
  *output_length = required;
  return true;
}

void telemob_terminal_scroll(TelemobTerminal* terminal, int32_t rows) {
  if (terminal == NULL || rows == 0) return;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
      .value = {.delta = rows},
  };
  ghostty_terminal_scroll_viewport(terminal->terminal, behavior);
  pthread_mutex_unlock(&terminal->mutex);
}

void telemob_terminal_scroll_to_bottom(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalScrollViewport behavior = {
      .tag = GHOSTTY_SCROLL_VIEWPORT_BOTTOM,
  };
  ghostty_terminal_scroll_viewport(terminal->terminal, behavior);
  pthread_mutex_unlock(&terminal->mutex);
}

bool telemob_terminal_select(
    TelemobTerminal* terminal,
    uint16_t start_column,
    uint16_t start_row,
    uint16_t end_column,
    uint16_t end_row) {
  if (terminal == NULL || start_column == 0 || start_row == 0 ||
      end_column == 0 || end_row == 0) {
    return false;
  }
  pthread_mutex_lock(&terminal->mutex);
  GhosttyPoint start_point = {
      .tag = GHOSTTY_POINT_TAG_VIEWPORT,
      .value.coordinate = {
          .x = (uint16_t)(start_column - 1),
          .y = (uint32_t)(start_row - 1),
      },
  };
  GhosttyPoint end_point = {
      .tag = GHOSTTY_POINT_TAG_VIEWPORT,
      .value.coordinate = {
          .x = (uint16_t)(end_column - 1),
          .y = (uint32_t)(end_row - 1),
      },
  };
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  const bool success =
      ghostty_terminal_grid_ref(
          terminal->terminal,
          start_point,
          &selection.start) == GHOSTTY_SUCCESS &&
      ghostty_terminal_grid_ref(
          terminal->terminal,
          end_point,
          &selection.end) == GHOSTTY_SUCCESS &&
      ghostty_terminal_set(
          terminal->terminal,
          GHOSTTY_TERMINAL_OPT_SELECTION,
          &selection) == GHOSTTY_SUCCESS;
  pthread_mutex_unlock(&terminal->mutex);
  return success;
}

void telemob_terminal_selection_clear(TelemobTerminal* terminal) {
  if (terminal == NULL) return;
  pthread_mutex_lock(&terminal->mutex);
  ghostty_terminal_set(
      terminal->terminal,
      GHOSTTY_TERMINAL_OPT_SELECTION,
      NULL);
  pthread_mutex_unlock(&terminal->mutex);
}

bool telemob_terminal_selection_text(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || output == NULL || output_length == NULL) return false;
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyTerminalSelectionFormatOptions options =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSelectionFormatOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.unwrap = true;
  options.trim = true;
  size_t required = 0;
  GhosttyResult result = ghostty_terminal_selection_format_buf(
      terminal->terminal,
      options,
      NULL,
      0,
      &required);
  if (result != GHOSTTY_OUT_OF_SPACE || required == 0) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  uint8_t* bytes = malloc(required);
  if (bytes == NULL) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  size_t written = 0;
  result = ghostty_terminal_selection_format_buf(
      terminal->terminal,
      options,
      bytes,
      required,
      &written);
  pthread_mutex_unlock(&terminal->mutex);
  if (result != GHOSTTY_SUCCESS) {
    free(bytes);
    return false;
  }
  *output = bytes;
  *output_length = written;
  return true;
}

typedef struct {
  uint32_t row;
  uint16_t column;
  uint16_t end_column;
  bool has_value;
} TelemobSearchMatch;

static bool search_position_before(
    uint32_t row,
    uint16_t column,
    uint32_t other_row,
    uint16_t other_column) {
  return row < other_row || (row == other_row && column < other_column);
}

static bool search_position_after(
    uint32_t row,
    uint16_t column,
    uint32_t other_row,
    uint16_t other_column) {
  return row > other_row || (row == other_row && column > other_column);
}

static void remember_search_match(
    TelemobSearchMatch* match,
    uint32_t row,
    uint16_t column,
    uint16_t end_column,
    bool prefer_later) {
  if (!match->has_value ||
      (prefer_later
          ? search_position_after(row, column, match->row, match->column)
          : search_position_before(row, column, match->row, match->column))) {
    *match = (TelemobSearchMatch){
        .row = row,
        .column = column,
        .end_column = end_column,
        .has_value = true,
    };
  }
}

bool telemob_terminal_find(
    TelemobTerminal* terminal,
    const uint8_t* query,
    size_t query_length,
    bool backwards) {
  if (terminal == NULL || query == NULL || query_length == 0 ||
      memchr(query, '\n', query_length) != NULL ||
      memchr(query, '\r', query_length) != NULL) {
    return false;
  }

  pthread_mutex_lock(&terminal->mutex);
  size_t total_rows = 0;
  if (ghostty_terminal_get(
          terminal->terminal,
          GHOSTTY_TERMINAL_DATA_TOTAL_ROWS,
          &total_rows) != GHOSTTY_SUCCESS ||
      total_rows == 0 || total_rows > UINT32_MAX) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  const bool same_query = terminal->search_query_length == query_length &&
      terminal->search_query != NULL &&
      memcmp(terminal->search_query, query, query_length) == 0;
  uint8_t* replacement_query = NULL;
  if (!same_query) {
    replacement_query = malloc(query_length);
    if (replacement_query == NULL) {
      pthread_mutex_unlock(&terminal->mutex);
      return false;
    }
    memcpy(replacement_query, query, query_length);
  }

  const size_t row_capacity = (size_t)terminal->columns *
      (TELEMOB_TERMINAL_CELL_TEXT_CAPACITY + 1);
  uint8_t* row_text = malloc(row_capacity == 0 ? 1 : row_capacity);
  uint16_t* byte_columns = malloc(
      (row_capacity == 0 ? 1 : row_capacity) * sizeof(*byte_columns));
  if (row_text == NULL || byte_columns == NULL) {
    free(replacement_query);
    free(row_text);
    free(byte_columns);
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  TelemobSearchMatch preferred = {0};
  TelemobSearchMatch wrapped = {0};
  const bool use_anchor = same_query && terminal->search_has_match;
  for (uint32_t row = 0; row < (uint32_t)total_rows; row += 1) {
    size_t row_length = 0;
    for (uint16_t column = 0; column < terminal->columns; column += 1) {
      GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
      const GhosttyPoint point = {
          .tag = GHOSTTY_POINT_TAG_SCREEN,
          .value.coordinate = {.x = column, .y = row},
      };
      if (ghostty_terminal_grid_ref(
              terminal->terminal,
              point,
              &ref) != GHOSTTY_SUCCESS) {
        continue;
      }
      GhosttyCell cell = 0;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      if (ghostty_grid_ref_cell(&ref, &cell) == GHOSTTY_SUCCESS) {
        ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide);
      }
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL ||
          wide == GHOSTTY_CELL_WIDE_SPACER_HEAD) {
        continue;
      }

      uint32_t stack_codepoints[16];
      uint32_t* codepoints = stack_codepoints;
      size_t codepoint_count = 0;
      GhosttyResult grapheme_result = ghostty_grid_ref_graphemes(
          &ref,
          codepoints,
          sizeof(stack_codepoints) / sizeof(stack_codepoints[0]),
          &codepoint_count);
      if (grapheme_result == GHOSTTY_OUT_OF_SPACE &&
          codepoint_count > sizeof(stack_codepoints) / sizeof(stack_codepoints[0])) {
        codepoints = codepoint_count <= SIZE_MAX / sizeof(*codepoints)
            ? malloc(codepoint_count * sizeof(*codepoints))
            : NULL;
        if (codepoints != NULL) {
          grapheme_result = ghostty_grid_ref_graphemes(
              &ref,
              codepoints,
              codepoint_count,
              &codepoint_count);
        }
      }
      if (grapheme_result == GHOSTTY_SUCCESS && codepoint_count > 0) {
        for (size_t index = 0; index < codepoint_count; index += 1) {
          char encoded[4];
          const size_t encoded_length = append_utf8(
              encoded,
              sizeof(encoded),
              codepoints[index]);
          if (encoded_length > row_capacity - row_length) break;
          memcpy(row_text + row_length, encoded, encoded_length);
          for (size_t byte = 0; byte < encoded_length; byte += 1) {
            byte_columns[row_length + byte] = column;
          }
          row_length += encoded_length;
        }
      } else if (row_length < row_capacity) {
        row_text[row_length] = ' ';
        byte_columns[row_length] = column;
        row_length += 1;
      }
      if (codepoints != stack_codepoints) free(codepoints);
    }

    if (query_length > row_length) continue;
    for (size_t offset = 0; offset + query_length <= row_length; offset += 1) {
      if (memcmp(row_text + offset, query, query_length) != 0) continue;
      const uint16_t column = byte_columns[offset];
      const uint16_t end_column = byte_columns[offset + query_length - 1];
      const bool preferred_side = !use_anchor ||
          (backwards
              ? search_position_before(
                    row,
                    column,
                    terminal->search_row,
                    terminal->search_column)
              : search_position_after(
                    row,
                    column,
                    terminal->search_row,
                    terminal->search_column));
      remember_search_match(
          preferred_side ? &preferred : &wrapped,
          row,
          column,
          end_column,
          backwards);
    }
  }
  free(row_text);
  free(byte_columns);

  const TelemobSearchMatch match = preferred.has_value ? preferred : wrapped;
  if (!match.has_value) {
    free(replacement_query);
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  const GhosttyPoint start_point = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value.coordinate = {.x = match.column, .y = match.row},
  };
  const GhosttyPoint end_point = {
      .tag = GHOSTTY_POINT_TAG_SCREEN,
      .value.coordinate = {.x = match.end_column, .y = match.row},
  };
  const bool selected =
      ghostty_terminal_grid_ref(
          terminal->terminal,
          start_point,
          &selection.start) == GHOSTTY_SUCCESS &&
      ghostty_terminal_grid_ref(
          terminal->terminal,
          end_point,
          &selection.end) == GHOSTTY_SUCCESS &&
      ghostty_terminal_set(
          terminal->terminal,
          GHOSTTY_TERMINAL_OPT_SELECTION,
          &selection) == GHOSTTY_SUCCESS;
  if (!selected) {
    free(replacement_query);
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }

  GhosttyTerminalScrollViewport scroll = {.tag = GHOSTTY_SCROLL_VIEWPORT_TOP};
  ghostty_terminal_scroll_viewport(terminal->terminal, scroll);
  const size_t maximum_offset = total_rows > terminal->rows_count
      ? total_rows - terminal->rows_count
      : 0;
  const size_t target_offset = match.row < maximum_offset
      ? match.row
      : maximum_offset;
  if (target_offset > 0) {
    scroll = (GhosttyTerminalScrollViewport){
        .tag = GHOSTTY_SCROLL_VIEWPORT_DELTA,
        .value = {.delta = (intptr_t)target_offset},
    };
    ghostty_terminal_scroll_viewport(terminal->terminal, scroll);
  }

  if (!same_query) {
    free(terminal->search_query);
    terminal->search_query = replacement_query;
    terminal->search_query_length = query_length;
  }
  terminal->search_row = match.row;
  terminal->search_column = match.column;
  terminal->search_has_match = true;
  pthread_mutex_unlock(&terminal->mutex);
  return true;
}

bool telemob_terminal_hyperlink(
    TelemobTerminal* terminal,
    uint16_t column,
    uint16_t row,
    uint8_t** output,
    size_t* output_length) {
  if (terminal == NULL || column == 0 || row == 0 || output == NULL ||
      output_length == NULL) {
    return false;
  }
  *output = NULL;
  *output_length = 0;
  pthread_mutex_lock(&terminal->mutex);
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  const GhosttyPoint point = {
      .tag = GHOSTTY_POINT_TAG_VIEWPORT,
      .value.coordinate = {
          .x = (uint16_t)(column - 1),
          .y = (uint32_t)(row - 1),
      },
  };
  if (ghostty_terminal_grid_ref(
          terminal->terminal,
          point,
          &ref) != GHOSTTY_SUCCESS) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  size_t required = 0;
  GhosttyResult result = ghostty_grid_ref_hyperlink_uri(
      &ref,
      NULL,
      0,
      &required);
  if (result != GHOSTTY_OUT_OF_SPACE || required == 0) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  uint8_t* bytes = malloc(required);
  if (bytes == NULL) {
    pthread_mutex_unlock(&terminal->mutex);
    return false;
  }
  size_t written = 0;
  result = ghostty_grid_ref_hyperlink_uri(
      &ref,
      bytes,
      required,
      &written);
  pthread_mutex_unlock(&terminal->mutex);
  if (result != GHOSTTY_SUCCESS) {
    free(bytes);
    return false;
  }
  *output = bytes;
  *output_length = written;
  return true;
}
