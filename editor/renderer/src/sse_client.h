#pragma once

#include "event_queue.h"
#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

class HttpStream;

// SSE client that connects to the Go editor's /sse/renderer endpoint over
// the platform's HTTP client and pushes parsed events to an EventQueue.
class SSEClient {
public:
    SSEClient(EventQueue& queue, const std::string& host, int port,
              const std::string& screenId, const std::string& token = "");
    ~SSEClient();

    void start();
    void stop();
    bool isConnected() const { return m_connected.load(); }

private:
    void run();
    void parseSSEStream(const char* data, size_t len);
    void logStats();

    EventQueue& m_queue;
    std::string m_host;
    int m_port;
    std::string m_screenId;
    std::string m_token;   // sidecar session token, sent in the stream URL
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_connected{false};
    // The open connection, so stop() can abort a blocked read.
    std::mutex m_streamMu;
    std::unique_ptr<HttpStream> m_stream;

    // SSE parser state
    std::string m_buffer;
    std::string m_eventType;
    std::string m_eventData;

    // Stats
    std::atomic<int> m_statBytesRead{0};
    std::atomic<int> m_statEventsReceived{0};
    std::atomic<int> m_statTimeEvents{0};
    std::atomic<int> m_statSnapshots{0};
    std::chrono::steady_clock::time_point m_lastStatLog;
};
