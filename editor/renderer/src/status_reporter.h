#pragma once

#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

// Posts status updates back to the Go editor via HTTP POST.
//
// Posts are queued and sent on a worker thread: WinHttp's synchronous
// send/receive on the render thread stalled a frame for as long as the editor
// took to answer.
class StatusReporter {
public:
    StatusReporter(const std::string& host, int port);
    ~StatusReporter();

    void reportReady(const std::string& screenId);
    void reportFPS(const std::string& screenId, double fps);
    void reportError(const std::string& screenId, const std::string& message);

    // Block until the queue drains (used on shutdown so a final error report
    // is not lost).
    void flush(int timeoutMs = 1000);

private:
    void enqueue(std::string body);
    void threadMain();
    void post(const std::string& body);

    std::string m_host;
    int m_port;

    std::thread m_thread;
    std::mutex m_mu;
    std::condition_variable m_cv;
    std::condition_variable m_drained;
    std::deque<std::string> m_queue;
    bool m_sending = false;
    std::atomic<bool> m_running{true};
};
