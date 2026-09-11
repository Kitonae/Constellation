#pragma once

#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <string>

using Microsoft::WRL::ComPtr;

static const UINT FRAME_COUNT = 2;

// Represents a single render window with its own swap chain.
//
// A screen no longer owns command allocators or a fence: frame
// synchronisation belongs to App, which drives every screen from one command
// list and one fence so uploads, draws and presents share the same timeline.
class Screen {
public:
    Screen(const std::string& screenId, int width, int height,
           ID3D12Device* device, ID3D12CommandQueue* cmdQueue, IDXGIFactory4* factory);
    ~Screen();

    // A window alone is not enough to render into: the swap chain must exist
    // too, or GetCurrentBackBufferIndex crashes on the first frame.
    bool isValid() const { return m_hwnd != nullptr && m_swapChain != nullptr; }
    HWND hwnd() const { return m_hwnd; }
    const std::string& screenId() const { return m_screenId; }
    int width() const { return m_width; }
    int height() const { return m_height; }

    // Record the PRESENT -> RENDER_TARGET transition for this frame.
    void beginFrame(ID3D12GraphicsCommandList* cmdList);
    // Record the RENDER_TARGET -> PRESENT transition. Does not submit.
    void endFrame(ID3D12GraphicsCommandList* cmdList);

    // Present the current back buffer. Returns false when the device was lost.
    bool present(UINT syncInterval);

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

    UINT m_frameIndex = 0;
    UINT m_rtvDescriptorSize = 0;
};
