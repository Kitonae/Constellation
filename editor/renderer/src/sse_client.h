#pragma once

#include "event_queue.h"
#include <string>
#include <thread>
#include <atomic>

// SSE client that connects to the Go editor's /sse/renderer endpoint
// via WinHTTP and pushes parsed events to an EventQueue.
class SSEClient {
public:
    SSEClient(EventQueue& queue, const std::string& host, int port, const std::string& screenId);
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
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::atomic<bool> m_connected{false};

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
