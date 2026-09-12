// WinHTTP implementation of the HTTP seam. Moved unchanged from
// sse_client.cpp and status_reporter.cpp.

#include "http_client.h"

#include <windows.h>
#include <winhttp.h>
#include <cstdio>

#pragma comment(lib, "winhttp.lib")

namespace {

std::wstring widen(const std::string& s) {
    return std::wstring(s.begin(), s.end());
}

class WinHttpStream : public HttpStream {
public:
    ~WinHttpStream() override { close(); }

    bool open(const std::string& host, int port, const std::string& path,
              const std::vector<HttpHeader>& headers, int* status) override {
        close();
        m_session = WinHttpOpen(L"ConstellationRenderer/1.0",
            WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
        if (!m_session) {
            fprintf(stderr, "[HTTP] WinHttpOpen failed: %lu\n", GetLastError());
            return false;
        }
        m_connect = WinHttpConnect(m_session, widen(host).c_str(), (INTERNET_PORT)port, 0);
        if (!m_connect) {
            fprintf(stderr, "[HTTP] WinHttpConnect failed: %lu\n", GetLastError());
            close();
            return false;
        }
        m_request = WinHttpOpenRequest(m_connect, L"GET", widen(path).c_str(),
            NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        if (!m_request) {
            fprintf(stderr, "[HTTP] WinHttpOpenRequest failed: %lu\n", GetLastError());
            close();
            return false;
        }
        for (const auto& h : headers) {
            std::wstring line = widen(h.name + ": " + h.value);
            WinHttpAddRequestHeaders(m_request, line.c_str(), (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
        }
        if (!WinHttpSendRequest(m_request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                                WINHTTP_NO_REQUEST_DATA, 0, 0, 0)) {
            fprintf(stderr, "[HTTP] WinHttpSendRequest failed: %lu\n", GetLastError());
            close();
            return false;
        }
        if (!WinHttpReceiveResponse(m_request, NULL)) {
            fprintf(stderr, "[HTTP] WinHttpReceiveResponse failed: %lu\n", GetLastError());
            close();
            return false;
        }
        if (status) {
            DWORD code = 0, size = sizeof(code);
            if (WinHttpQueryHeaders(m_request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                    WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, WINHTTP_NO_HEADER_INDEX)) {
                *status = (int)code;
            }
        }
        return true;
    }

    int read(char* buf, size_t cap) override {
        if (!m_request) return -1;
        DWORD available = 0;
        // In synchronous mode WinHttpQueryDataAvailable blocks until data
        // arrives, so zero means the response ended.
        if (!WinHttpQueryDataAvailable(m_request, &available)) {
            fprintf(stderr, "[HTTP] QueryDataAvailable error: %lu\n", GetLastError());
            return -1;
        }
        if (available == 0) return 0;
        DWORD toRead = (available < cap) ? available : (DWORD)cap;
        DWORD bytesRead = 0;
        if (!WinHttpReadData(m_request, buf, toRead, &bytesRead)) {
            fprintf(stderr, "[HTTP] Read error: %lu\n", GetLastError());
            return -1;
        }
        return (int)bytesRead;
    }

    void abort() override {
        // Closing the request handle fails any blocked call on it.
        if (m_request) { WinHttpCloseHandle(m_request); m_request = nullptr; }
    }

    void close() override {
        if (m_request) { WinHttpCloseHandle(m_request); m_request = nullptr; }
        if (m_connect) { WinHttpCloseHandle(m_connect); m_connect = nullptr; }
        if (m_session) { WinHttpCloseHandle(m_session); m_session = nullptr; }
    }

private:
    HINTERNET m_session = nullptr;
    HINTERNET m_connect = nullptr;
    HINTERNET m_request = nullptr;
};

} // namespace

std::unique_ptr<HttpStream> createHttpStream() {
    return std::make_unique<WinHttpStream>();
}

bool httpPost(const std::string& host, int port, const std::string& path,
              const std::vector<HttpHeader>& headers, const std::string& body, int* status) {
    HINTERNET hSession = WinHttpOpen(L"ConstellationRenderer/1.0",
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return false;

    HINTERNET hConnect = WinHttpConnect(hSession, widen(host).c_str(), (INTERNET_PORT)port, 0);
    if (!hConnect) {
        WinHttpCloseHandle(hSession);
        return false;
    }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"POST", widen(path).c_str(),
        NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return false;
    }

    for (const auto& h : headers) {
        std::wstring line = widen(h.name + ": " + h.value);
        WinHttpAddRequestHeaders(hRequest, line.c_str(), (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);
    }

    bool ok = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        (LPVOID)body.c_str(), (DWORD)body.size(), (DWORD)body.size(), 0) &&
        WinHttpReceiveResponse(hRequest, NULL);
    if (ok && status) {
        DWORD code = 0, size = sizeof(code);
        if (WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, WINHTTP_NO_HEADER_INDEX)) {
            *status = (int)code;
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return ok;
}
