cmake_minimum_required(VERSION 3.20)
project(constellation-renderer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE)
    enable_language(OBJCXX)
    set(CMAKE_OBJCXX_STANDARD 20)
    set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
    # MTLSharedEvent's timed wait and AVAsset's async track loading are
    # macOS 12 API; the NDI dylib is built for 13.
    if(NOT CMAKE_OSX_DEPLOYMENT_TARGET)
        set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS" FORCE)
    endif()
    option(RENDERER_UNIVERSAL "Build a universal (arm64 + x86_64) binary" OFF)
    if(RENDERER_UNIVERSAL)
        set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "" FORCE)
    endif()
endif()

# Fetch nlohmann/json (header-only)
include(FetchContent)
FetchContent_Declare(
    json
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_MakeAvailable(json)

# Shared between platforms: the protocol, the timeline, the codecs' bitstream
# work and the overlay text.
set(CORE_SOURCES
    src/main.cpp
    src/app_common.cpp
    src/sse_client.cpp
    src/status_reporter.cpp
    src/scene.cpp
    src/h264_parser.cpp
    src/snappy_decode.cpp
    src/hap_decoder.cpp
    src/thumbnail.cpp
    src/media_loader.cpp
    src/debug_text.cpp
)

if(WIN32)
    set(PLATFORM_INCLUDE src/win)
    set(PLATFORM_SOURCES
        src/win/app_win.cpp
        src/win/screen.cpp
        src/win/render_pipeline.cpp
        src/win/texture_cache.cpp
        src/win/video_decoder.cpp
        src/win/d3d12_video_decoder.cpp
        src/win/video_buffer.cpp
        src/win/audio_player.cpp
        src/win/ndi_sender.cpp
        src/win/http_client_winhttp.cpp
        src/win/image_io_win.cpp
        src/win/platform_win.cpp
    )
elseif(APPLE)
    set(PLATFORM_INCLUDE src/mac)
    set(PLATFORM_SOURCES
        src/mac/app_mac.mm
        src/mac/screen.mm
        src/mac/render_pipeline.mm
        src/mac/texture_cache.mm
        src/mac/video_decoder.mm
        src/mac/video_buffer.mm
        src/mac/audio_player.mm
        src/mac/ndi_sender.mm
        src/mac/image_io_mac.mm
        src/mac/platform_mac.mm
        src/posix/http_client_posix.cpp
    )
else()
    message(FATAL_ERROR "constellation-renderer builds on Windows and macOS only")
endif()

add_executable(constellation-renderer ${CORE_SOURCES} ${PLATFORM_SOURCES})
target_include_directories(constellation-renderer PRIVATE src ${PLATFORM_INCLUDE})
target_link_libraries(constellation-renderer PRIVATE nlohmann_json::nlohmann_json)

if(WIN32)
    target_link_libraries(constellation-renderer PRIVATE
        # DX12
        d3d12
        dxgi
        d3d11
        d3dcompiler
        dxguid
        # Media Foundation
        mf
        mfplat
        mfreadwrite
        mfuuid
        # WIC (image loading)
        windowscodecs
        # WinHTTP (SSE client)
        winhttp
    )
endif()

if(APPLE)
    set(MAC_FRAMEWORKS
        "-framework Cocoa" "-framework Metal" "-framework QuartzCore"
        "-framework AVFoundation" "-framework CoreMedia" "-framework CoreVideo"
        "-framework VideoToolbox" "-framework AudioToolbox" "-framework CoreAudio"
        "-framework CoreFoundation" "-framework ImageIO" "-framework CoreGraphics"
        "-framework Accelerate" "-framework IOSurface"
    )
    target_link_libraries(constellation-renderer PRIVATE ${MAC_FRAMEWORKS})
    target_compile_options(constellation-renderer PRIVATE
        $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>
        -Wall -Wextra -Wno-unused-parameter)

    # Metal shaders: compiled to a metallib and embedded as a header, the way
    # the Windows build embeds dxc output.
    set(SHADER_OUTPUT_DIR "${CMAKE_BINARY_DIR}/shaders")
    file(MAKE_DIRECTORY ${SHADER_OUTPUT_DIR})
    add_custom_command(
        OUTPUT ${SHADER_OUTPUT_DIR}/quad.air
        COMMAND xcrun -sdk macosx metal -std=macos-metal2.3 -O2 -c
            ${CMAKE_SOURCE_DIR}/shaders/quad.metal -o ${SHADER_OUTPUT_DIR}/quad.air
        DEPENDS ${CMAKE_SOURCE_DIR}/shaders/quad.metal
        COMMENT "Compiling quad.metal"
    )
    add_custom_command(
        OUTPUT ${SHADER_OUTPUT_DIR}/shaders.metallib
        COMMAND xcrun -sdk macosx metallib ${SHADER_OUTPUT_DIR}/quad.air
            -o ${SHADER_OUTPUT_DIR}/shaders.metallib
        DEPENDS ${SHADER_OUTPUT_DIR}/quad.air
        COMMENT "Linking shaders.metallib"
    )
    add_custom_command(
        OUTPUT ${SHADER_OUTPUT_DIR}/shaders_metallib.h
        COMMAND ${CMAKE_COMMAND}
            -DIN=${SHADER_OUTPUT_DIR}/shaders.metallib
            -DOUT=${SHADER_OUTPUT_DIR}/shaders_metallib.h
            -DSYM=g_shadersMetallib
            -P ${CMAKE_SOURCE_DIR}/cmake/bin2h.cmake
        DEPENDS ${SHADER_OUTPUT_DIR}/shaders.metallib ${CMAKE_SOURCE_DIR}/cmake/bin2h.cmake
        COMMENT "Embedding shaders.metallib"
    )
    target_sources(constellation-renderer PRIVATE ${SHADER_OUTPUT_DIR}/shaders_metallib.h)
    target_include_directories(constellation-renderer PRIVATE ${SHADER_OUTPUT_DIR})
endif()

# NDI SDK
set(NDI_SDK_DIR "$ENV{NDI_SDK_DIR}")
if(APPLE AND NOT NDI_SDK_DIR AND EXISTS "/Library/NDI SDK for Apple/include/Processing.NDI.Lib.h")
    set(NDI_SDK_DIR "/Library/NDI SDK for Apple")
endif()
if(NDI_SDK_DIR)
    if(WIN32)
        target_include_directories(constellation-renderer PRIVATE "${NDI_SDK_DIR}/Include")
        target_link_libraries(constellation-renderer PRIVATE "${NDI_SDK_DIR}/Lib/x64/Processing.NDI.Lib.x64.lib")
        # Copy NDI runtime DLL next to the exe
        set(NDI_RUNTIME_DIR "$ENV{NDI_RUNTIME_DIR_V6}")
        if(NDI_RUNTIME_DIR)
            add_custom_command(TARGET constellation-renderer POST_BUILD
                COMMAND ${CMAKE_COMMAND} -E copy_if_different
                    "${NDI_RUNTIME_DIR}/Processing.NDI.Lib.x64.dll"
                    "$<TARGET_FILE_DIR:constellation-renderer>/Processing.NDI.Lib.x64.dll"
                COMMENT "Copying NDI runtime DLL")
        endif()
    else()
        set(NDI_DYLIB "${NDI_SDK_DIR}/lib/macOS/libndi.dylib")
        target_include_directories(constellation-renderer PRIVATE "${NDI_SDK_DIR}/include")
        target_link_libraries(constellation-renderer PRIVATE "${NDI_DYLIB}")
        # The dylib's install name is @rpath/libndi.dylib: find it next to the
        # binary (packaged) or in the SDK (development).
        set_target_properties(constellation-renderer PROPERTIES
            BUILD_RPATH "@executable_path;${NDI_SDK_DIR}/lib/macOS"
            INSTALL_RPATH "@executable_path")
        add_custom_command(TARGET constellation-renderer POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${NDI_DYLIB}" "$<TARGET_FILE_DIR:constellation-renderer>/libndi.dylib"
            COMMENT "Copying libndi.dylib")
    endif()
    target_compile_definitions(constellation-renderer PRIVATE HAS_NDI=1)
    message(STATUS "NDI SDK found at ${NDI_SDK_DIR}")
else()
    message(WARNING "NDI SDK not found (NDI_SDK_DIR env var not set) -- NDI output disabled")
    target_compile_definitions(constellation-renderer PRIVATE HAS_NDI=0)
endif()

include(CTest)
if(BUILD_TESTING)
    set(TEST_SOURCES
        tests/regression.cpp
        src/h264_parser.cpp
        src/snappy_decode.cpp
        src/hap_decoder.cpp
        src/media_loader.cpp
    )
    if(WIN32)
        list(APPEND TEST_SOURCES
            src/win/video_buffer.cpp
            src/win/video_decoder.cpp
            src/win/d3d12_video_decoder.cpp
            src/win/image_io_win.cpp
            src/win/platform_win.cpp
        )
    else()
        list(APPEND TEST_SOURCES
            src/mac/video_buffer.mm
            src/mac/video_decoder.mm
            src/mac/image_io_mac.mm
            src/mac/platform_mac.mm
            src/mac/screen.mm
            tests/test_helpers_mac.mm
        )
    endif()
    add_executable(renderer-regression-tests ${TEST_SOURCES})
    target_include_directories(renderer-regression-tests PRIVATE src ${PLATFORM_INCLUDE} tests)
    target_link_libraries(renderer-regression-tests PRIVATE nlohmann_json::nlohmann_json)
    if(WIN32)
        target_link_libraries(renderer-regression-tests PRIVATE
            d3d12 dxgi d3d11 dxguid mf mfplat mfreadwrite mfuuid windowscodecs ole32 propsys
        )
    else()
        target_link_libraries(renderer-regression-tests PRIVATE ${MAC_FRAMEWORKS})
        target_compile_options(renderer-regression-tests PRIVATE
            $<$<COMPILE_LANGUAGE:OBJCXX>:-fobjc-arc>)
    endif()
    set(TEST_CASES buffers pool loader bitstream nal sps snappy hap events uri)
    if(APPLE)
        list(APPEND TEST_CASES placement)
    endif()
    foreach(case ${TEST_CASES})
        add_test(NAME renderer-${case} COMMAND renderer-regression-tests ${case})
        set_tests_properties(renderer-${case} PROPERTIES TIMEOUT 15)
    endforeach()
endif()

# Compile HLSL shaders to headers (Windows)
if(WIN32)
    find_program(DXC dxc HINTS "$ENV{WindowsSdkDir}/bin/$ENV{WindowsSDKVersion}/x64" "C:/Program Files (x86)/Windows Kits/10/bin/10.0.22621.0/x64")
    if(DXC)
        set(SHADER_OUTPUT_DIR "${CMAKE_BINARY_DIR}/shaders")
        file(MAKE_DIRECTORY ${SHADER_OUTPUT_DIR})

        # Vertex shader
        add_custom_command(
            OUTPUT ${SHADER_OUTPUT_DIR}/quad_vs.h
            COMMAND ${DXC} -T vs_6_0 -E VSMain -Fh ${SHADER_OUTPUT_DIR}/quad_vs.h -Vn g_quadVS
                ${CMAKE_SOURCE_DIR}/shaders/quad_vs.hlsl
            DEPENDS ${CMAKE_SOURCE_DIR}/shaders/quad_vs.hlsl
            COMMENT "Compiling quad_vs.hlsl"
        )

        # Pixel shader (BGRA)
        add_custom_command(
            OUTPUT ${SHADER_OUTPUT_DIR}/effects_ps.h
            COMMAND ${DXC} -T ps_6_0 -E PSMain -Fh ${SHADER_OUTPUT_DIR}/effects_ps.h -Vn g_effectsPS
                ${CMAKE_SOURCE_DIR}/shaders/effects_ps.hlsl
            DEPENDS ${CMAKE_SOURCE_DIR}/shaders/effects_ps.hlsl
            COMMENT "Compiling effects_ps.hlsl"
        )

        # NV12 pixel shader (YUV→RGB + effects)
        add_custom_command(
            OUTPUT ${SHADER_OUTPUT_DIR}/nv12_effects_ps.h
            COMMAND ${DXC} -T ps_6_0 -E PSMain -Fh ${SHADER_OUTPUT_DIR}/nv12_effects_ps.h -Vn g_nv12EffectsPS
                ${CMAKE_SOURCE_DIR}/shaders/nv12_effects_ps.hlsl
            DEPENDS ${CMAKE_SOURCE_DIR}/shaders/nv12_effects_ps.hlsl
            COMMENT "Compiling nv12_effects_ps.hlsl"
        )

        target_sources(constellation-renderer PRIVATE
            ${SHADER_OUTPUT_DIR}/quad_vs.h
            ${SHADER_OUTPUT_DIR}/effects_ps.h
            ${SHADER_OUTPUT_DIR}/nv12_effects_ps.h
        )
        target_include_directories(constellation-renderer PRIVATE ${SHADER_OUTPUT_DIR})
    else()
        message(WARNING "dxc not found -- shaders will be compiled at runtime via D3DCompile")
        target_compile_definitions(constellation-renderer PRIVATE SHADERS_COMPILE_AT_RUNTIME=1)
    endif()
endif()
