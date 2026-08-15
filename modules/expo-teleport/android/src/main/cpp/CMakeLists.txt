cmake_minimum_required(VERSION 3.22.1)
project(telemob_terminal LANGUAGES C)

set(TELEMOB_NATIVE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../native")
set(GHOSTTY_ROOT "${TELEMOB_NATIVE_DIR}/ghostty/android/${ANDROID_ABI}")

if(NOT EXISTS "${GHOSTTY_ROOT}/lib/libghostty-vt.a")
  message(FATAL_ERROR
    "Missing libghostty-vt for ${ANDROID_ABI}. Run scripts/build-ghostty-terminal.sh android first.")
endif()

add_library(ghostty-vt STATIC IMPORTED)
set_target_properties(ghostty-vt PROPERTIES
  IMPORTED_LOCATION "${GHOSTTY_ROOT}/lib/libghostty-vt.a")

add_library(telemob_terminal_jni SHARED
  telemob_terminal_jni.c
  "${TELEMOB_NATIVE_DIR}/telemob_terminal.c")

target_compile_features(telemob_terminal_jni PRIVATE c_std_11)
target_compile_options(telemob_terminal_jni PRIVATE -Wall -Wextra -Werror)
target_include_directories(telemob_terminal_jni PRIVATE
  "${TELEMOB_NATIVE_DIR}"
  "${GHOSTTY_ROOT}/include")
target_link_options(telemob_terminal_jni PRIVATE "-Wl,-z,max-page-size=16384")
target_link_libraries(telemob_terminal_jni PRIVATE ghostty-vt android log m)
