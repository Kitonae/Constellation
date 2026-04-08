#pragma once

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <string>

using Microsoft::WRL::ComPtr;

static const UINT FRAME_COUNT = 2;

// Represents a single render window with its own swap chain.
class Screen {
public:
    Screen(const std::string& screenId, int width, int height,
           ID3D12Device* device, ID3D12CommandQueue* cmdQueue, IDXGIFactory4* factory);
    ~Screen();

    bool isValid() const { return m_hwnd != nullptr; }
    HWND hwnd() const { return m_hwnd; }
    const std::string& screenId() const { return m_screenId; }
    int width() const { return m_width; }
    int height() const { return m_height; }

    // Prepare for rendering: wait for previous frame, reset command allocator
    void beginFrame(ID3D12GraphicsCommandList* cmdList);
    // Finalize and present
    void endFrame(ID3D12GraphicsCommandList* cmdList, ID3D12CommandQueue* cmdQueue);

    D3D12_CPU_DESCRIPTOR_HANDLE currentRTV() const;
    ID3D12Resource* currentBackBuffer() const;

private:
    static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);

    std::string m_screenId;
    int m_width, m_height;
    HWND m_hwnd = nullptr;

    ComPtr<IDXGISwapChain3> m_swapChain;
    ComPtr<ID3D12DescriptorHeap> m_rtvHeap;
    ComPtr<ID3D12Resource> m_renderTargets[FRAME_COUNT];
    ComPtr<ID3D12CommandAllocator> m_cmdAllocators[FRAME_COUNT];

    ComPtr<ID3D12Fence> m_fence;
    UINT64 m_fenceValues[FRAME_COUNT] = {};
    HANDLE m_fenceEvent = nullptr;
    UINT m_frameIndex = 0;
    UINT m_rtvDescriptorSize = 0;
};
