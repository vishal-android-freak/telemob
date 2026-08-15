#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "telemob_terminal.h"

static TelemobTerminal* from_handle(jlong handle) {
  return (TelemobTerminal*)(intptr_t)handle;
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
  if (!telemob_terminal_take_pty_write(from_handle(handle), &output, &output_size) ||
      output_size > INT32_MAX) {
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
