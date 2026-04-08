#pragma once

#include <queue>
#include <mutex>
#include <optional>
#include <string>
#include <nlohmann/json.hpp>

// Simple thread-safe event queue for SSE thread -> render thread communication.
struct SSEEvent {
    std::string type;       // "snapshot", "time", "screen-open", "screen-close", "control"
    nlohmann::json data;    // parsed JSON payload (or null for bare values)
    double timeValue = 0.0; // shortcut for time events
};

class EventQueue {
public:
    void push(SSEEvent event) {
        std::lock_guard<std::mutex> lock(m_mutex);
        m_queue.push(std::move(event));
    }

    std::optional<SSEEvent> tryPop() {
        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_queue.empty()) return std::nullopt;
        auto event = std::move(m_queue.front());
        m_queue.pop();
        return event;
    }

    bool empty() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_queue.empty();
    }

private:
    mutable std::mutex m_mutex;
    std::queue<SSEEvent> m_queue;
};
