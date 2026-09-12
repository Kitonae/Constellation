#include "sse_client.h"
#include "http_client.h"
#include "platform.h"
#include <cstdio>
#include <cstdlib>
#include <mutex>

SSEClient::SSEClient(EventQueue& queue, const std::string& host, int port,
                     const std::string& screenId, const std::string& token)
    : m_queue(queue), m_host(host), m_port(port), m_screenId(screenId), m_token(token),
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
    {
        // Wake a read that is blocked on the socket so join() is prompt.
        std::lock_guard<std::mutex> lk(m_streamMu);
        if (m_stream) m_stream->abort();
    }
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

        // Build path. The token is hex, so it needs no escaping.
        std::string path = "/sse/renderer?screen=" + m_screenId;
        if (!m_token.empty()) path += "&token=" + m_token;

        std::unique_ptr<HttpStream> stream = createHttpStream();
        int status = 0;
        bool opened = stream && stream->open(m_host, m_port, path,
            {{"Accept", "text/event-stream"}}, &status);
        if (!opened || status != 200) {
            if (!opened) fprintf(stderr, "[SSE] Connect to %s:%d failed\n", m_host.c_str(), m_port);
            else fprintf(stderr, "[SSE] Server answered %d (a 401 means the token does not match)\n", status);
            if (stream) stream->close();
            for (int i = 0; i < 10 && m_running; i++) platformSleepMs(100);
            continue;
        }
        {
            std::lock_guard<std::mutex> lk(m_streamMu);
            m_stream = std::move(stream);
        }

        printf("[SSE] Connected to %s:%d%s\n", m_host.c_str(), m_port, path.c_str());
        m_connected = true;

        char buf[16384];
        while (m_running) {
            int n = m_stream->read(buf, sizeof(buf));
            if (n < 0) {
                fprintf(stderr, "[SSE] Read error\n");
                break;
            }
            if (n == 0) {
                // The response ended. Treating it as "nothing yet" left us
                // waiting forever with m_connected still true, so a graceful
                // server restart never reconnected.
                printf("[SSE] Server closed the stream\n");
                break;
            }
            m_statBytesRead.fetch_add(n);
            parseSSEStream(buf, (size_t)n);
            logStats();
        }

        m_connected = false;
        {
            std::lock_guard<std::mutex> lk(m_streamMu);
            m_stream->close();
            m_stream.reset();
        }

        if (m_running) {
            printf("[SSE] Disconnected, reconnecting in 1s...\n");
            for (int i = 0; i < 10 && m_running; i++) platformSleepMs(100);
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
                    event.timeValue = strtod(m_eventData.c_str(), nullptr);
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
