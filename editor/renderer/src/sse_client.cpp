#include "sse_client.h"
#include <windows.h>
#include <winhttp.h>
#include <cstdio>
#include <charconv>

#pragma comment(lib, "winhttp.lib")

SSEClient::SSEClient(EventQueue& queue, const std::string& host, int port, const std::string& screenId)
    : m_queue(queue), m_host(host), m_port(port), m_screenId(screenId),
      m_lastStatLog(std::chrono::steady_clock::now()) {}

SSEClient::~SSEClient() {
    stop();
}

void SSEClient::start() {
    m_running = true;
    m_thread = std::thread(&SSEClient::run, this);
}

void SSEClient::stop() {
    m_running = false;
    if (m_thread.joinable()) {
        m_thread.join();
    }
}

void SSEClient::run() {
    while (m_running) {
        m_connected = false;
        m_buffer.clear();
        m_eventType.clear();
        m_eventData.clear();

        // Convert host to wide string
        std::wstring whost(m_host.begin(), m_host.end());

        HINTERNET hSession = WinHttpOpen(L"ConstellationRenderer/1.0",
            WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!hSession) {
            fprintf(stderr, "[SSE] WinHttpOpen failed: %lu\n", GetLastError());
            Sleep(1000);
            continue;
        }

        HINTERNET hConnect = WinHttpConnect(hSession, whost.c_str(), (INTERNET_PORT)m_port, 0);
        if (!hConnect) {
            fprintf(stderr, "[SSE] WinHttpConnect failed: %lu\n", GetLastError());
            WinHttpCloseHandle(hSession);
            Sleep(1000);
            continue;
        }

        // Build path
        std::string path = "/sse/renderer?screen=" + m_screenId;
        std::wstring wpath(path.begin(), path.end());

        HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", wpath.c_str(),
            NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        if (!hRequest) {
            fprintf(stderr, "[SSE] WinHttpOpenRequest failed: %lu\n", GetLastError());
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            Sleep(1000);
            continue;
        }

        // Add Accept header for SSE
        WinHttpAddRequestHeaders(hRequest, L"Accept: text/event-stream", (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);

        BOOL bResults = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0);
        if (!bResults) {
            fprintf(stderr, "[SSE] WinHttpSendRequest failed: %lu\n", GetLastError());
            WinHttpCloseHandle(hRequest);
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            Sleep(1000);
            continue;
        }

        bResults = WinHttpReceiveResponse(hRequest, NULL);
        if (!bResults) {
            fprintf(stderr, "[SSE] WinHttpReceiveResponse failed: %lu\n", GetLastError());
            WinHttpCloseHandle(hRequest);
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            Sleep(1000);
            continue;
        }

        printf("[SSE] Connected to %s:%d%s\n", m_host.c_str(), m_port, path.c_str());
        m_connected = true;

        // Read streaming response — use WinHttpQueryDataAvailable to avoid
        // blocking until the full buffer fills (SSE events are small and frequent).
        char buf[16384];
        DWORD bytesRead = 0;
        while (m_running) {
            DWORD bytesAvailable = 0;
            if (!WinHttpQueryDataAvailable(hRequest, &bytesAvailable)) {
                fprintf(stderr, "[SSE] QueryDataAvailable error: %lu\n", GetLastError());
                break;
            }
            if (bytesAvailable == 0) {
                // In synchronous mode WinHttpQueryDataAvailable blocks until
                // data arrives, so zero means the response ended. Treating it
                // as "nothing yet" left us sleeping forever with m_connected
                // still true, so a graceful server restart never reconnected.
                printf("[SSE] Server closed the stream\n");
                break;
            }
            DWORD toRead = (bytesAvailable < sizeof(buf)) ? bytesAvailable : sizeof(buf);
            if (!WinHttpReadData(hRequest, buf, toRead, &bytesRead)) {
                fprintf(stderr, "[SSE] Read error: %lu\n", GetLastError());
                break;
            }
            if (bytesRead == 0) {
                // Connection closed
                break;
            }
            m_statBytesRead.fetch_add((int)bytesRead);
            parseSSEStream(buf, bytesRead);
            logStats();
        }

        m_connected = false;
        WinHttpCloseHandle(hRequest);
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);

        if (m_running) {
            printf("[SSE] Disconnected, reconnecting in 1s...\n");
            Sleep(1000);
        }
    }
}

void SSEClient::parseSSEStream(const char* data, size_t len) {
    m_buffer.append(data, len);

    // Process complete lines
    size_t pos = 0;
    while (pos < m_buffer.size()) {
        size_t nl = m_buffer.find('\n', pos);
        if (nl == std::string::npos) break;

        std::string line = m_buffer.substr(pos, nl - pos);
        pos = nl + 1;

        // Strip trailing \r
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }

        if (line.empty()) {
            // Empty line = end of event
            if (!m_eventData.empty()) {
                SSEEvent event;
                event.type = m_eventType.empty() ? "message" : m_eventType;

                if (event.type == "time") {
                    // Parse bare float
                    double t = 0;
                    auto [ptr, ec] = std::from_chars(m_eventData.data(), m_eventData.data() + m_eventData.size(), t);
                    event.timeValue = t;
                } else {
                    // Parse JSON
                    try {
                        event.data = nlohmann::json::parse(m_eventData);
                    } catch (...) {
                        // Store as raw string
                        event.data = m_eventData;
                    }
                }

                m_statEventsReceived.fetch_add(1);
                if (event.type == "time") m_statTimeEvents.fetch_add(1);
                else if (event.type == "snapshot") m_statSnapshots.fetch_add(1);
                m_queue.push(std::move(event));
            }
            m_eventType.clear();
            m_eventData.clear();
        } else if (line.starts_with("event:")) {
            m_eventType = line.substr(6);
            // Trim leading space
            if (!m_eventType.empty() && m_eventType[0] == ' ') {
                m_eventType = m_eventType.substr(1);
            }
        } else if (line.starts_with("data:")) {
            std::string val = line.substr(5);
            if (!val.empty() && val[0] == ' ') {
                val = val.substr(1);
            }
            if (!m_eventData.empty()) m_eventData += '\n';
            m_eventData += val;
        }
        // Ignore "id:", "retry:", comments (":")
    }

    // Remove processed data from buffer
    if (pos > 0) {
        m_buffer.erase(0, pos);
    }
}

void SSEClient::logStats() {
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - m_lastStatLog).count();
    if (elapsed < 5) return;

    int bytes = m_statBytesRead.exchange(0);
    int events = m_statEventsReceived.exchange(0);
    int times = m_statTimeEvents.exchange(0);
    int snaps = m_statSnapshots.exchange(0);

    printf("[SSE stats] %ds: bytes=%d  events=%d  time=%d  snapshots=%d  buf=%zu\n",
        (int)elapsed, bytes, events, times, snaps, m_buffer.size());

    m_lastStatLog = now;
}
