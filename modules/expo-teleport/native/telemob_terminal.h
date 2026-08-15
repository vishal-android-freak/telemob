#ifndef TELEMOB_TERMINAL_H
#define TELEMOB_TERMINAL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define TELEMOB_TERMINAL_CELL_TEXT_CAPACITY 64
#define TELEMOB_TERMINAL_SNAPSHOT_HEADER_SIZE 16
#define TELEMOB_TERMINAL_SNAPSHOT_CELL_SIZE (8 + TELEMOB_TERMINAL_CELL_TEXT_CAPACITY)

typedef enum {
  TELEMOB_TERMINAL_CURSOR_BAR = 0,
  TELEMOB_TERMINAL_CURSOR_BLOCK = 1,
  TELEMOB_TERMINAL_CURSOR_UNDERLINE = 2,
  TELEMOB_TERMINAL_CURSOR_HOLLOW = 3,
} TelemobTerminalCursorStyle;

typedef enum {
  TELEMOB_TERMINAL_CELL_BOLD = 1 << 0,
  TELEMOB_TERMINAL_CELL_ITALIC = 1 << 1,
  TELEMOB_TERMINAL_CELL_FAINT = 1 << 2,
  TELEMOB_TERMINAL_CELL_BLINK = 1 << 3,
  TELEMOB_TERMINAL_CELL_INVERSE = 1 << 4,
  TELEMOB_TERMINAL_CELL_INVISIBLE = 1 << 5,
  TELEMOB_TERMINAL_CELL_STRIKETHROUGH = 1 << 6,
  TELEMOB_TERMINAL_CELL_UNDERLINE = 1 << 7,
} TelemobTerminalCellFlags;

typedef struct {
  uint8_t foreground_red;
  uint8_t foreground_green;
  uint8_t foreground_blue;
  uint8_t background_red;
  uint8_t background_green;
  uint8_t background_blue;
  uint8_t flags;
  uint8_t text_length;
  char text[TELEMOB_TERMINAL_CELL_TEXT_CAPACITY];
} TelemobTerminalCell;

typedef struct {
  uint16_t columns;
  uint16_t rows;
  uint16_t cursor_column;
  uint16_t cursor_row;
  uint8_t cursor_visible;
  uint8_t cursor_style;
  uint8_t background_red;
  uint8_t background_green;
  uint8_t background_blue;
  uint8_t foreground_red;
  uint8_t foreground_green;
  uint8_t foreground_blue;
  size_t cell_count;
  TelemobTerminalCell* cells;
} TelemobTerminalSnapshot;

typedef struct TelemobTerminal TelemobTerminal;

TelemobTerminal* telemob_terminal_create(uint16_t columns, uint16_t rows);
void telemob_terminal_destroy(TelemobTerminal* terminal);
void telemob_terminal_reset(TelemobTerminal* terminal);
void telemob_terminal_write(TelemobTerminal* terminal, const uint8_t* bytes, size_t length);
bool telemob_terminal_resize(
    TelemobTerminal* terminal,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height);
bool telemob_terminal_snapshot(TelemobTerminal* terminal, TelemobTerminalSnapshot* snapshot);
void telemob_terminal_snapshot_free(TelemobTerminalSnapshot* snapshot);
bool telemob_terminal_snapshot_bytes(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
void telemob_terminal_bytes_free(uint8_t* bytes);
bool telemob_terminal_modes(
    TelemobTerminal* terminal,
    bool* alternate_screen,
    bool* mouse_tracking,
    bool* bracketed_paste);
bool telemob_terminal_take_pty_write(
    TelemobTerminal* terminal,
    uint8_t** output,
    size_t* output_length);
void telemob_terminal_scroll(TelemobTerminal* terminal, int32_t rows);
void telemob_terminal_scroll_to_bottom(TelemobTerminal* terminal);

#ifdef __cplusplus
}
#endif

#endif
