#include "screen.h"
#include <cstdio>

static const wchar_t* WINDOW_CLASS_NAME = L"ConstellationRendererScreen";
static bool s_classRegistered = false;

// Widening bytes one-to-one mangles any non-ASCII screen id; go through the
// real UTF-8 conversion instead.
static std::wstring utf8ToWide(const std::string& s) {
    if (s.empty()) return std::wstring();
    int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
    std::wstring out((size_t)len, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), out.data(), len);
    return out;
}

Screen::Screen(const std::string& screenId, int width, int height,
               ID3D12Device* device, ID3D12CommandQueue* cmdQueue, IDXGIFactory4* factory)
    : m_screenId(screenId), m_width(width), m_height(height)
{
    // Register window class once
    if (!s_classRegistered) {
        WNDCLASSEXW wc = {};
        wc.cbSize = sizeof(wc);
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = WndProc;
        wc.hInstance = GetModuleHandle(nullptr);
        wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
        wc.lpszClassName = WINDOW_CLASS_NAME;
        RegisterClassExW(&wc);
        s_classRegistered = true;
    }

    // Create window
    std::wstring title = L"Renderer: " + utf8ToWide(screenId);
    RECT rect = {0, 0, width, height};
    AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);

    m_hwnd = CreateWindowExW(0, WINDOW_CLASS_NAME, title.c_str(),
        WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
        rect.right - rect.left, rect.bottom - rect.top,
        nullptr, nullptr, GetModuleHandle(nullptr), nullptr);

    if (!m_hwnd) {
        fprintf(stderr, "[Screen] Failed to create window for %s\n", screenId.c_str());
        return;
    }

    ShowWindow(m_hwnd, SW_SHOW);

    // Create RTV descriptor heap
    D3D12_DESCRIPTOR_HEAP_DESC rtvDesc = {};
    rtvDesc.NumDescriptors = FRAME_COUNT;
    rtvDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    if (FAILED(device->CreateDescriptorHeap(&rtvDesc, IID_PPV_ARGS(&m_rtvHeap)))) {
        fprintf(stderr, "[Screen] RTV heap creation failed for %s\n", screenId.c_str());
        DestroyWindow(m_hwnd);
        m_hwnd = nullptr;
        return;
    }
    m_rtvDescriptorSize = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_RTV);

    // Create swap chain
    DXGI_SWAP_CHAIN_DESC1 scDesc = {};
    scDesc.BufferCount = FRAME_COUNT;
    scDesc.Width = width;
    scDesc.Height = height;
    scDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    scDesc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    scDesc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    scDesc.SampleDesc.Count = 1;

    ComPtr<IDXGISwapChain1> sc1;
    HRESULT hr = factory->CreateSwapChainForHwnd(cmdQueue, m_hwnd, &scDesc, nullptr, nullptr, &sc1);
    if (FAILED(hr) || !sc1) {
        // Unchecked, this failure surfaced later as a crash on the first
        // GetCurrentBackBufferIndex.
        fprintf(stderr, "[Screen] CreateSwapChainForHwnd failed for %s: 0x%08x\n",
            screenId.c_str(), hr);
        DestroyWindow(m_hwnd);
        m_hwnd = nullptr;
        return;
    }
    if (FAILED(sc1.As(&m_swapChain)) || !m_swapChain) {
        fprintf(stderr, "[Screen] IDXGISwapChain3 unavailable for %s\n", screenId.c_str());
        DestroyWindow(m_hwnd);
        m_hwnd = nullptr;
        return;
    }

    // Disable Alt+Enter fullscreen
    factory->MakeWindowAssociation(m_hwnd, DXGI_MWA_NO_ALT_ENTER);

    m_frameIndex = m_swapChain->GetCurrentBackBufferIndex();

    // Create RTVs
    D3D12_CPU_DESCRIPTOR_HANDLE rtvHandle = m_rtvHeap->GetCPUDescriptorHandleForHeapStart();
    for (UINT i = 0; i < FRAME_COUNT; i++) {
        if (FAILED(m_swapChain->GetBuffer(i, IID_PPV_ARGS(&m_renderTargets[i])))) {
            fprintf(stderr, "[Screen] GetBuffer(%u) failed for %s\n", i, screenId.c_str());
            m_swapChain.Reset();
            DestroyWindow(m_hwnd);
            m_hwnd = nullptr;
            return;
        }
        device->CreateRenderTargetView(m_renderTargets[i].Get(), nullptr, rtvHandle);
        rtvHandle.ptr += m_rtvDescriptorSize;
    }

    printf("[Screen] Created %s (%dx%d)\n", screenId.c_str(), width, height);
}

Screen::~Screen() {
    // App flushes the GPU before destroying screens.
    if (m_hwnd) {
        DestroyWindow(m_hwnd);
        m_hwnd = nullptr;
    }
}

D3D12_CPU_DESCRIPTOR_HANDLE Screen::currentRTV() const {
    D3D12_CPU_DESCRIPTOR_HANDLE handle = m_rtvHeap->GetCPUDescriptorHandleForHeapStart();
    handle.ptr += m_frameIndex * m_rtvDescriptorSize;
    return handle;
}

ID3D12Resource* Screen::currentBackBuffer() const {
    return m_renderTargets[m_frameIndex].Get();
}

void Screen::beginFrame(ID3D12GraphicsCommandList* cmdList) {
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = currentBackBuffer();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmdList->ResourceBarrier(1, &barrier);
}

void Screen::endFrame(ID3D12GraphicsCommandList* cmdList) {
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = currentBackBuffer();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmdList->ResourceBarrier(1, &barrier);
}

bool Screen::present(UINT syncInterval) {
    if (!m_swapChain) return true;
    HRESULT hr = m_swapChain->Present(syncInterval, 0);
    if (hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET) {
        fprintf(stderr, "[Screen] %s: device lost on Present: 0x%08x\n", m_screenId.c_str(), hr);
        return false;
    }
    if (FAILED(hr)) {
        fprintf(stderr, "[Screen] %s: Present failed: 0x%08x\n", m_screenId.c_str(), hr);
    }
    m_frameIndex = m_swapChain->GetCurrentBackBufferIndex();
    return true;
}

LRESULT CALLBACK Screen::WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_DESTROY:
        return 0;
    case WM_CLOSE:
        // Don't destroy — let the app handle it
        ShowWindow(hwnd, SW_HIDE);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}
