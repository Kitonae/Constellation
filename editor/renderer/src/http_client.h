#pragma once
// The two HTTP shapes the renderer needs from the editor's sidecar: a
// streaming GET that stays open for server-sent events, and a fire-and-forget
// POST. Windows implements them on WinHTTP, macOS on POSIX sockets; the SSE
// parser and the status queue above them are shared.

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

struct HttpHeader {
    std::string name;
    std::string value;
};

class HttpStream {
public:
    virtual ~HttpStream() = default;

    // Connect, send the request and read the response headers. Returns false
    // on any failure; `status` receives the HTTP status when one was read.
    virtual bool open(const std::string& host, int port, const std::string& path,
                      const std::vector<HttpHeader>& headers, int* status) = 0;

    // Body bytes as they arrive, transfer coding already removed. Returns the
    // count read, 0 when the server closed the response, or a negative value
    // on error. Blocks, but never for longer than about a second, so a caller
    // polling a stop flag between reads stays responsive.
    virtual int read(char* buf, size_t cap) = 0;

    // From another thread: make a blocked read() return promptly.
    virtual void abort() = 0;

    virtual void close() = 0;
};

std::unique_ptr<HttpStream> createHttpStream();

// One request, one response, connection closed. Returns false when no
// response was received; `status` receives the status when one was.
bool httpPost(const std::string& host, int port, const std::string& path,
              const std::vector<HttpHeader>& headers, const std::string& body,
              int* status = nullptr);
