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
        // For time events, replace the pending one instead of queuing — only the latest matters
        if (event.type == "time") {
            m_pendingTime = std::move(event);
            m_hasTime = true;
            return;
        }
        m_queue.push(std::move(event));
    }

    std::optional<SSEEvent> tryPop() {
        std::lock_guard<std::mutex> lock(m_mutex);
        // Drain the latest time event first if no other events pending
        if (m_queue.empty()) {
            if (m_hasTime) {
                m_hasTime = false;
                return std::move(m_pendingTime);
            }
            return std::nullopt;
        }
        auto event = std::move(m_queue.front());
        m_queue.pop();
        return event;
    }

    // Drain all queued events into a vector, collapsing time events to the latest.
    std::vector<SSEEvent> drainAll() {
        std::lock_guard<std::mutex> lock(m_mutex);
        std::vector<SSEEvent> result;
        while (!m_queue.empty()) {
            result.push_back(std::move(m_queue.front()));
            m_queue.pop();
        }
        if (m_hasTime) {
            result.push_back(std::move(m_pendingTime));
            m_hasTime = false;
        }
        return result;
    }

    bool empty() const {
        std::lock_guard<std::mutex> lock(m_mutex);
        return m_queue.empty() && !m_hasTime;
    }

private:
    mutable std::mutex m_mutex;
    std::queue<SSEEvent> m_queue;
    SSEEvent m_pendingTime;
    bool m_hasTime = false;
};
