#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "telemob_terminal.h"

static TelemobTerminal* from_handle(jlong handle) {
  return (TelemobTerminal*)(intptr_t)handle;
}

static jbyteArray encoded_bytes(
    JNIEnv* env,
    bool success,
    uint8_t* output,
    size_t output_size) {
  if (!success || output_size > INT32_MAX) {
    telemob_terminal_bytes_free(output);
    return NULL;
  }
  jbyteArray result = (*env)->NewByteArray(env, (jsize)output_size);
  if (result != NULL && output_size > 0) {
    (*env)->SetByteArrayRegion(
        env,
        result,
        0,
        (jsize)output_size,
        (const jbyte*)output);
  }
  telemob_terminal_bytes_free(output);
  return result;
}

JNIEXPORT jlong JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeCreate(
    JNIEnv* env,
    jobject self,
    jint columns,
    jint rows) {
  (void)env;
  (void)self;
  if (columns < 1 || columns > UINT16_MAX || rows < 1 || rows > UINT16_MAX) return 0;
  return (jlong)(intptr_t)telemob_terminal_create((uint16_t)columns, (uint16_t)rows);
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeDestroy(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  telemob_terminal_destroy(from_handle(handle));
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeReset(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  telemob_terminal_reset(from_handle(handle));
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeWrite(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jbyteArray data) {
  (void)self;
  if (handle == 0 || data == NULL) return;
  const jsize length = (*env)->GetArrayLength(env, data);
  if (length <= 0) return;
  jbyte* bytes = (*env)->GetByteArrayElements(env, data, NULL);
  if (bytes == NULL) return;
  telemob_terminal_write(from_handle(handle), (const uint8_t*)bytes, (size_t)length);
  (*env)->ReleaseByteArrayElements(env, data, bytes, JNI_ABORT);
}

JNIEXPORT jboolean JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeResize(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint columns,
    jint rows,
    jint cell_width,
    jint cell_height) {
  (void)env;
  (void)self;
  if (handle == 0 || columns < 1 || columns > UINT16_MAX || rows < 1 ||
      rows > UINT16_MAX || cell_width < 1 || cell_height < 1) {
    return JNI_FALSE;
  }
  return telemob_terminal_resize(
             from_handle(handle),
             (uint16_t)columns,
             (uint16_t)rows,
             (uint32_t)cell_width,
             (uint32_t)cell_height)
      ? JNI_TRUE
      : JNI_FALSE;
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeSnapshot(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)self;
  if (handle == 0) return NULL;

  uint8_t* output = NULL;
  size_t output_size = 0;
  if (!telemob_terminal_snapshot_bytes(from_handle(handle), &output, &output_size) ||
      output_size > INT32_MAX) {
    telemob_terminal_bytes_free(output);
    return NULL;
  }
  const jsize output_length = (jsize)output_size;

  jbyteArray result = (*env)->NewByteArray(env, output_length);
  if (result != NULL) {
    (*env)->SetByteArrayRegion(env, result, 0, output_length, (const jbyte*)output);
  }
  telemob_terminal_bytes_free(output);
  return result;
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeScroll(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint rows) {
  (void)env;
  (void)self;
  if (handle != 0) telemob_terminal_scroll(from_handle(handle), rows);
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeScrollToBottom(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  if (handle != 0) telemob_terminal_scroll_to_bottom(from_handle(handle));
}

JNIEXPORT jboolean JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeSelect(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint start_column,
    jint start_row,
    jint end_column,
    jint end_row) {
  (void)env;
  (void)self;
  if (handle == 0 || start_column < 1 || start_column > UINT16_MAX ||
      start_row < 1 || start_row > UINT16_MAX || end_column < 1 ||
      end_column > UINT16_MAX || end_row < 1 || end_row > UINT16_MAX) {
    return JNI_FALSE;
  }
  return telemob_terminal_select(
             from_handle(handle),
             (uint16_t)start_column,
             (uint16_t)start_row,
             (uint16_t)end_column,
             (uint16_t)end_row)
      ? JNI_TRUE
      : JNI_FALSE;
}

JNIEXPORT void JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeClearSelection(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  if (handle != 0) telemob_terminal_selection_clear(from_handle(handle));
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeSelectionText(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)self;
  if (handle == 0) return NULL;
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success =
      telemob_terminal_selection_text(from_handle(handle), &output, &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jboolean JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeFind(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jbyteArray query,
    jboolean backwards) {
  (void)self;
  if (handle == 0 || query == NULL) return JNI_FALSE;
  const jsize length = (*env)->GetArrayLength(env, query);
  if (length <= 0) return JNI_FALSE;
  jbyte* bytes = (*env)->GetByteArrayElements(env, query, NULL);
  if (bytes == NULL) return JNI_FALSE;
  const bool found = telemob_terminal_find(
      from_handle(handle),
      (const uint8_t*)bytes,
      (size_t)length,
      backwards == JNI_TRUE);
  (*env)->ReleaseByteArrayElements(env, query, bytes, JNI_ABORT);
  return found ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeHyperlink(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint column,
    jint row) {
  (void)self;
  if (handle == 0 || column < 1 || column > UINT16_MAX || row < 1 ||
      row > UINT16_MAX) {
    return NULL;
  }
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success = telemob_terminal_hyperlink(
      from_handle(handle),
      (uint16_t)column,
      (uint16_t)row,
      &output,
      &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jbooleanArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeModes(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)self;
  if (handle == 0) return NULL;
  bool alternate_screen = false;
  bool mouse_tracking = false;
  bool bracketed_paste = false;
  if (!telemob_terminal_modes(
          from_handle(handle),
          &alternate_screen,
          &mouse_tracking,
          &bracketed_paste)) {
    return NULL;
  }
  const jboolean values[3] = {
      alternate_screen ? JNI_TRUE : JNI_FALSE,
      mouse_tracking ? JNI_TRUE : JNI_FALSE,
      bracketed_paste ? JNI_TRUE : JNI_FALSE,
  };
  jbooleanArray result = (*env)->NewBooleanArray(env, 3);
  if (result != NULL) (*env)->SetBooleanArrayRegion(env, result, 0, 3, values);
  return result;
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeTakePtyWrite(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)self;
  if (handle == 0) return NULL;
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success =
      telemob_terminal_take_pty_write(from_handle(handle), &output, &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeTakeTitle(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)self;
  if (handle == 0) return NULL;
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success =
      telemob_terminal_take_title(from_handle(handle), &output, &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jint JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeTakeBellCount(
    JNIEnv* env,
    jobject self,
    jlong handle) {
  (void)env;
  (void)self;
  return handle == 0 ? 0 : (jint)telemob_terminal_take_bell_count(from_handle(handle));
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeEncodeKey(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint key,
    jbyteArray text,
    jint modifiers,
    jint action) {
  (void)self;
  if (handle == 0) return NULL;
  jbyte* text_bytes = NULL;
  jsize text_length = 0;
  if (text != NULL) {
    text_length = (*env)->GetArrayLength(env, text);
    if (text_length > 0) {
      text_bytes = (*env)->GetByteArrayElements(env, text, NULL);
      if (text_bytes == NULL) return NULL;
    }
  }
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success = telemob_terminal_encode_key(
      from_handle(handle),
      (int32_t)key,
      (const uint8_t*)text_bytes,
      (size_t)text_length,
      (uint16_t)modifiers,
      (int32_t)action,
      &output,
      &output_size);
  if (text_bytes != NULL) {
    (*env)->ReleaseByteArrayElements(env, text, text_bytes, JNI_ABORT);
  }
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeEncodeMouse(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jint action,
    jint button,
    jint modifiers,
    jint column,
    jint row) {
  (void)self;
  if (handle == 0 || column < 1 || column > UINT16_MAX ||
      row < 1 || row > UINT16_MAX) {
    return NULL;
  }
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success = telemob_terminal_encode_mouse(
      from_handle(handle),
      (int32_t)action,
      (int32_t)button,
      (uint16_t)modifiers,
      (uint16_t)column,
      (uint16_t)row,
      &output,
      &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeEncodeFocus(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jboolean focused) {
  (void)self;
  if (handle == 0) return NULL;
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success = telemob_terminal_encode_focus(
      from_handle(handle),
      focused == JNI_TRUE,
      &output,
      &output_size);
  return encoded_bytes(env, success, output, output_size);
}

JNIEXPORT jbyteArray JNICALL
Java_com_naarang_telemob_teleport_GhosttyTerminalEngine_nativeEncodePaste(
    JNIEnv* env,
    jobject self,
    jlong handle,
    jbyteArray data) {
  (void)self;
  if (handle == 0 || data == NULL) return NULL;
  const jsize data_length = (*env)->GetArrayLength(env, data);
  jbyte* data_bytes = data_length > 0
      ? (*env)->GetByteArrayElements(env, data, NULL)
      : NULL;
  if (data_length > 0 && data_bytes == NULL) return NULL;
  uint8_t* output = NULL;
  size_t output_size = 0;
  const bool success = telemob_terminal_encode_paste(
      from_handle(handle),
      (const uint8_t*)data_bytes,
      (size_t)data_length,
      &output,
      &output_size);
  if (data_bytes != NULL) {
    (*env)->ReleaseByteArrayElements(env, data, data_bytes, JNI_ABORT);
  }
  return encoded_bytes(env, success, output, output_size);
}
