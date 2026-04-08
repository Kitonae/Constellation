#include "status_reporter.h"
#include <windows.h>
#include <winhttp.h>
#include <cstdio>

#pragma comment(lib, "winhttp.lib")

StatusReporter::StatusReporter(const std::string& host, int port)
    : m_host(host), m_port(port) {}

void StatusReporter::reportReady(const std::string& screenId) {
    std::string body = "{\"screenId\":\"" + screenId + "\",\"state\":\"ready\"}";
    post(body);
}

void StatusReporter::reportFPS(const std::string& screenId, double fps) {
    char buf[256];
    snprintf(buf, sizeof(buf), "{\"screenId\":\"%s\",\"fps\":%.1f}", screenId.c_str(), fps);
    post(std::string(buf));
}

void StatusReporter::reportError(const std::string& screenId, const std::string& message) {
    // Simple JSON escaping for the message
    std::string escaped;
    for (char c : message) {
        if (c == '"') escaped += "\\\"";
        else if (c == '\\') escaped += "\\\\";
        else if (c == '\n') escaped += "\\n";
        else escaped += c;
    }
    std::string body = "{\"screenId\":\"" + screenId + "\",\"state\":\"error\",\"error\":\"" + escaped + "\"}";
    post(body);
}

void StatusReporter::post(const std::string& body) {
    std::wstring whost(m_host.begin(), m_host.end());

    HINTERNET hSession = WinHttpOpen(L"ConstellationRenderer/1.0",
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return;

    HINTERNET hConnect = WinHttpConnect(hSession, whost.c_str(), (INTERNET_PORT)m_port, 0);
    if (!hConnect) {
        WinHttpCloseHandle(hSession);
        return;
    }

    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"POST", L"/api/renderer/status",
        NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return;
    }

    WinHttpAddRequestHeaders(hRequest, L"Content-Type: application/json", (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD);

    WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        (LPVOID)body.c_str(), (DWORD)body.size(), (DWORD)body.size(), 0);
    WinHttpReceiveResponse(hRequest, NULL);

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
}
