#include "status_reporter.h"
#include "http_client.h"
#include <chrono>
#include <cstdio>

StatusReporter::StatusReporter(const std::string& host, int port, const std::string& token)
    : m_host(host), m_port(port), m_token(token) {
    m_thread = std::thread(&StatusReporter::threadMain, this);
}

StatusReporter::~StatusReporter() {
    m_running = false;
    m_cv.notify_all();
    if (m_thread.joinable()) m_thread.join();
}

void StatusReporter::enqueue(std::string body) {
    {
        std::lock_guard<std::mutex> lk(m_mu);
        m_queue.push_back(std::move(body));
    }
    m_cv.notify_one();
}

void StatusReporter::flush(int timeoutMs) {
    std::unique_lock<std::mutex> lk(m_mu);
    m_drained.wait_for(lk, std::chrono::milliseconds(timeoutMs),
        [this] { return m_queue.empty() && !m_sending; });
}

void StatusReporter::threadMain() {
    while (true) {
        std::string body;
        {
            std::unique_lock<std::mutex> lk(m_mu);
            m_cv.wait(lk, [this] { return !m_queue.empty() || !m_running.load(); });
            if (m_queue.empty()) {
                if (!m_running.load()) return;
                continue;
            }
            body = std::move(m_queue.front());
            m_queue.pop_front();
            m_sending = true;
        }
        post(body);
        {
            std::lock_guard<std::mutex> lk(m_mu);
            m_sending = false;
        }
        m_drained.notify_all();
    }
}

void StatusReporter::reportReady(const std::string& screenId) {
    enqueue("{\"screenId\":\"" + screenId + "\",\"state\":\"ready\"}");
}

void StatusReporter::reportFPS(const std::string& screenId, double fps) {
    char buf[256];
    snprintf(buf, sizeof(buf), "{\"screenId\":\"%s\",\"fps\":%.1f}", screenId.c_str(), fps);
    enqueue(std::string(buf));
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
    enqueue("{\"screenId\":\"" + screenId + "\",\"state\":\"error\",\"error\":\"" + escaped + "\"}");
}

void StatusReporter::post(const std::string& body) {
    std::vector<HttpHeader> headers = {{"Content-Type", "application/json"}};
    if (!m_token.empty()) headers.push_back({"X-Constellation-Token", m_token});
    httpPost(m_host, m_port, "/api/renderer/status", headers, body);
}
