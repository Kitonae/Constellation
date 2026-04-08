#include "screen.h"
#include <cstdio>

static const wchar_t* WINDOW_CLASS_NAME = L"ConstellationRendererScreen";
static bool s_classRegistered = false;

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
    std::wstring title = L"Renderer: " + std::wstring(screenId.begin(), screenId.end());
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
    device->CreateDescriptorHeap(&rtvDesc, IID_PPV_ARGS(&m_rtvHeap));
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
    factory->CreateSwapChainForHwnd(cmdQueue, m_hwnd, &scDesc, nullptr, nullptr, &sc1);
    sc1.As(&m_swapChain);

    // Disable Alt+Enter fullscreen
    factory->MakeWindowAssociation(m_hwnd, DXGI_MWA_NO_ALT_ENTER);

    m_frameIndex = m_swapChain->GetCurrentBackBufferIndex();

    // Create RTVs and command allocators
    D3D12_CPU_DESCRIPTOR_HANDLE rtvHandle = m_rtvHeap->GetCPUDescriptorHandleForHeapStart();
    for (UINT i = 0; i < FRAME_COUNT; i++) {
        m_swapChain->GetBuffer(i, IID_PPV_ARGS(&m_renderTargets[i]));
        device->CreateRenderTargetView(m_renderTargets[i].Get(), nullptr, rtvHandle);
        rtvHandle.ptr += m_rtvDescriptorSize;

        device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&m_cmdAllocators[i]));
    }

    // Create fence
    device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_fence));
    m_fenceEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);

    printf("[Screen] Created %s (%dx%d)\n", screenId.c_str(), width, height);
}

Screen::~Screen() {
    // Wait for GPU
    if (m_fence && m_fenceEvent) {
        for (UINT i = 0; i < FRAME_COUNT; i++) {
            if (m_fence->GetCompletedValue() < m_fenceValues[i]) {
                m_fence->SetEventOnCompletion(m_fenceValues[i], m_fenceEvent);
                WaitForSingleObject(m_fenceEvent, 1000);
            }
        }
        CloseHandle(m_fenceEvent);
    }
    if (m_hwnd) {
        DestroyWindow(m_hwnd);
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
    // Wait for the previous frame on this buffer
    if (m_fence->GetCompletedValue() < m_fenceValues[m_frameIndex]) {
        m_fence->SetEventOnCompletion(m_fenceValues[m_frameIndex], m_fenceEvent);
        WaitForSingleObject(m_fenceEvent, INFINITE);
    }

    m_cmdAllocators[m_frameIndex]->Reset();
    cmdList->Reset(m_cmdAllocators[m_frameIndex].Get(), nullptr);

    // Transition to render target
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = currentBackBuffer();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmdList->ResourceBarrier(1, &barrier);
}

void Screen::endFrame(ID3D12GraphicsCommandList* cmdList, ID3D12CommandQueue* cmdQueue) {
    // Transition to present
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = currentBackBuffer();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmdList->ResourceBarrier(1, &barrier);

    cmdList->Close();
    ID3D12CommandList* lists[] = {cmdList};
    cmdQueue->ExecuteCommandLists(1, lists);

    m_swapChain->Present(1, 0); // vsync

    // Signal fence
    m_fenceValues[m_frameIndex]++;
    cmdQueue->Signal(m_fence.Get(), m_fenceValues[m_frameIndex]);
    m_frameIndex = m_swapChain->GetCurrentBackBufferIndex();
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
