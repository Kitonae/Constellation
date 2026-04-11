cmake_minimum_required(VERSION 3.20)
project(constellation-renderer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Fetch nlohmann/json (header-only)
include(FetchContent)
FetchContent_Declare(
    json
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_MakeAvailable(json)

add_executable(constellation-renderer
    src/main.cpp
    src/app.cpp
    src/sse_client.cpp
    src/status_reporter.cpp
    src/scene.cpp
    src/screen.cpp
    src/render_pipeline.cpp
    src/texture_cache.cpp
    src/video_decoder.cpp
    src/audio_player.cpp
    src/ndi_sender.cpp
    src/debug_text.cpp
)

target_link_libraries(constellation-renderer PRIVATE
    # DX12
    d3d12
    dxgi
    d3d11
    d3dcompiler
    dxguid
    # Media Foundation (for future video support)
    mf
    mfplat
    mfreadwrite
    mfuuid
    # WIC (image loading)
    windowscodecs
    # WinHTTP (SSE client)
    winhttp
    # JSON
    nlohmann_json::nlohmann_json
)

# NDI SDK
set(NDI_SDK_DIR "$ENV{NDI_SDK_DIR}")
if(NDI_SDK_DIR)
    target_include_directories(constellation-renderer PRIVATE "${NDI_SDK_DIR}/Include")
    target_link_libraries(constellation-renderer PRIVATE "${NDI_SDK_DIR}/Lib/x64/Processing.NDI.Lib.x64.lib")
    target_compile_definitions(constellation-renderer PRIVATE HAS_NDI=1)
    # Copy NDI runtime DLL next to the exe
    set(NDI_RUNTIME_DIR "$ENV{NDI_RUNTIME_DIR_V6}")
    if(NDI_RUNTIME_DIR)
        add_custom_command(TARGET constellation-renderer POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${NDI_RUNTIME_DIR}/Processing.NDI.Lib.x64.dll"
                "$<TARGET_FILE_DIR:constellation-renderer>/Processing.NDI.Lib.x64.dll"
            COMMENT "Copying NDI runtime DLL")
    endif()
    message(STATUS "NDI SDK found at ${NDI_SDK_DIR}")
else()
    message(WARNING "NDI SDK not found (NDI_SDK_DIR env var not set) -- NDI output disabled")
    target_compile_definitions(constellation-renderer PRIVATE HAS_NDI=0)
endif()

target_include_directories(constellation-renderer PRIVATE src)

# Compile HLSL shaders to headers
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
