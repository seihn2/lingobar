cmake_minimum_required(VERSION 3.20)
project(LingoBarSystemAudio LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "Build the WASAPI helper with a Windows toolchain.")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR NOT CMAKE_GENERATOR_PLATFORM STREQUAL "x64")
  message(FATAL_ERROR "LingoBar currently supports Windows x64 only; configure with -A x64.")
endif()

add_executable(system-audio-capture SystemAudioCapture.cpp)
target_compile_features(system-audio-capture PRIVATE cxx_std_17)
target_compile_definitions(system-audio-capture PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
target_link_libraries(system-audio-capture PRIVATE ole32)
if(MSVC)
  target_compile_options(system-audio-capture PRIVATE /W4 /WX /EHsc)
  # An installed VC++ runtime must not be a prerequisite for the audio helper.
  set_property(TARGET system-audio-capture PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
