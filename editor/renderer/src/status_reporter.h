#pragma once

#include <string>

// Posts status updates back to the Go editor via HTTP POST.
class StatusReporter {
public:
    StatusReporter(const std::string& host, int port);

    void reportReady(const std::string& screenId);
    void reportFPS(const std::string& screenId, double fps);
    void reportError(const std::string& screenId, const std::string& message);

private:
    void post(const std::string& body);

    std::string m_host;
    int m_port;
};
