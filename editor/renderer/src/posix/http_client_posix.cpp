// POSIX-socket implementation of the HTTP seam.
//
// The sidecar is always plain HTTP on localhost, and the SSE reader needs to
// see bytes as they arrive, so a small HTTP/1.1 client over a blocking socket
// with a short receive timeout is all this takes. Go writes flushed SSE
// responses with chunked transfer coding, which is undone here so the parser
// above sees the event stream itself.

#include "http_client.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <algorithm>
#include <mutex>

namespace {

int connectTo(const std::string& host, int port, int timeoutMs) {
    struct addrinfo hints = {};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo* res = nullptr;
    const std::string portStr = std::to_string(port);
    if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0) return -1;

    int fd = -1;
    for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
        if (fd < 0) continue;
        int on = 1;
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof(on));
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));

        // Non-blocking connect with a deadline, then back to blocking.
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        int rc = connect(fd, ai->ai_addr, ai->ai_addrlen);
        if (rc != 0 && errno == EINPROGRESS) {
            struct pollfd pfd = { fd, POLLOUT, 0 };
            if (poll(&pfd, 1, timeoutMs) > 0) {
                int err = 0; socklen_t len = sizeof(err);
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
                rc = (err == 0) ? 0 : -1;
            } else {
                rc = -1;
            }
        }
        fcntl(fd, F_SETFL, flags);
        if (rc == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(res);
    if (fd >= 0) {
        // Bounded reads so a caller polling a stop flag gets a turn.
        struct timeval tv = { 1, 0 };
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    }
    return fd;
}

bool sendAll(int fd, const std::string& data) {
    size_t off = 0;
    while (off < data.size()) {
        ssize_t n = send(fd, data.data() + off, data.size() - off, 0);
        if (n <= 0) {
            if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
            return false;
        }
        off += (size_t)n;
    }
    return true;
}

std::string lower(std::string s) {
    for (auto& c : s) c = (char)tolower((unsigned char)c);
    return s;
}

// Read until the blank line that ends the headers. Whatever follows it is
// body and is handed back in `rest`.
bool readHeaders(int fd, std::string& headers, std::string& rest, int timeoutMs) {
    std::string buf;
    char tmp[4096];
    int waited = 0;
    while (true) {
        size_t end = buf.find("\r\n\r\n");
        if (end != std::string::npos) {
            headers = buf.substr(0, end + 4);
            rest = buf.substr(end + 4);
            return true;
        }
        ssize_t n = recv(fd, tmp, sizeof(tmp), 0);
        if (n == 0) return false;
        if (n < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                waited += 1000;
                if (waited >= timeoutMs) return false;
                continue;
            }
            if (errno == EINTR) continue;
            return false;
        }
        buf.append(tmp, (size_t)n);
        if (buf.size() > 65536) return false;
    }
}

int parseStatus(const std::string& headers) {
    // HTTP/1.1 200 OK
    size_t sp = headers.find(' ');
    if (sp == std::string::npos) return 0;
    return atoi(headers.c_str() + sp + 1);
}

bool isChunked(const std::string& headers) {
    std::string h = lower(headers);
    size_t p = h.find("transfer-encoding:");
    if (p == std::string::npos) return false;
    size_t eol = h.find("\r\n", p);
    return h.substr(p, eol - p).find("chunked") != std::string::npos;
}

class PosixHttpStream : public HttpStream {
public:
    ~PosixHttpStream() override { close(); }

    bool open(const std::string& host, int port, const std::string& path,
              const std::vector<HttpHeader>& headers, int* status) override {
        close();
        int fd = connectTo(host, port, 2000);
        if (fd < 0) return false;
        {
            std::lock_guard<std::mutex> lk(m_mu);
            m_fd = fd;
        }
        std::string req = "GET " + path + " HTTP/1.1\r\nHost: " + host + ":" + std::to_string(port) +
                          "\r\nUser-Agent: ConstellationRenderer/1.0\r\nConnection: keep-alive\r\n";
        for (const auto& h : headers) req += h.name + ": " + h.value + "\r\n";
        req += "\r\n";
        if (!sendAll(fd, req)) { close(); return false; }

        std::string hdrs;
        if (!readHeaders(fd, hdrs, m_pending, 5000)) { close(); return false; }
        if (status) *status = parseStatus(hdrs);
        m_chunked = isChunked(hdrs);
        m_chunkRemaining = 0;
        m_eof = false;
        return true;
    }

    int read(char* buf, size_t cap) override {
        if (cap == 0) return 0;
        if (!m_chunked) return readRaw(buf, cap);

        // Chunked: hand out body bytes only, consuming the framing here.
        while (true) {
            if (m_eof) return 0;
            if (m_chunkRemaining > 0) {
                size_t want = std::min(cap, m_chunkRemaining);
                int n = readRaw(buf, want);
                if (n <= 0) return n;
                m_chunkRemaining -= (size_t)n;
                if (m_chunkRemaining == 0) {
                    // CRLF after the chunk data
                    if (!consumeLine()) return -1;
                }
                return n;
            }
            // Next chunk-size line
            std::string line;
            if (!readLine(line)) return m_eof ? 0 : -1;
            if (line.empty()) continue;   // tolerate stray blank lines
            size_t size = (size_t)strtoul(line.c_str(), nullptr, 16);
            if (size == 0) {
                // Trailer section, then end of the response
                std::string trailer;
                while (readLine(trailer) && !trailer.empty()) {}
                m_eof = true;
                return 0;
            }
            m_chunkRemaining = size;
        }
    }

    void abort() override {
        std::lock_guard<std::mutex> lk(m_mu);
        if (m_fd >= 0) shutdown(m_fd, SHUT_RDWR);
    }

    void close() override {
        std::lock_guard<std::mutex> lk(m_mu);
        if (m_fd >= 0) { ::close(m_fd); m_fd = -1; }
        m_pending.clear();
        m_chunked = false;
        m_chunkRemaining = 0;
        m_eof = false;
    }

private:
    // Bytes off the wire, serving the header read's leftover first. Returns
    // 0 on a closed connection, a negative value on error; a receive timeout
    // is reported as -2 and retried by the chunked layer, or surfaced as
    // "nothing yet" (0 bytes read, connection open) by the raw path.
    int readRaw(char* buf, size_t cap) {
        if (!m_pending.empty()) {
            size_t n = std::min(cap, m_pending.size());
            memcpy(buf, m_pending.data(), n);
            m_pending.erase(0, n);
            return (int)n;
        }
        int fd;
        {
            std::lock_guard<std::mutex> lk(m_mu);
            fd = m_fd;
        }
        if (fd < 0) return -1;
        while (true) {
            ssize_t n = recv(fd, buf, cap, 0);
            if (n > 0) return (int)n;
            if (n == 0) { m_eof = true; return 0; }
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) {
                // Timed out: report as a zero-length read without EOF so the
                // caller can check its stop flag and call again. SSE keepalives
                // arrive every 15 s, so this happens routinely.
                return readRawTimeout(buf, cap);
            }
            return -1;
        }
    }

    // A receive timeout is not the end of the stream. Wait for more data
    // in one-second slices for as long as the socket stays open; abort()
    // shuts the socket down, which makes recv return 0.
    int readRawTimeout(char* buf, size_t cap) {
        int fd;
        {
            std::lock_guard<std::mutex> lk(m_mu);
            fd = m_fd;
        }
        if (fd < 0) return -1;
        while (true) {
            ssize_t n = recv(fd, buf, cap, 0);
            if (n > 0) return (int)n;
            if (n == 0) { m_eof = true; return 0; }
            if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK) {
                std::lock_guard<std::mutex> lk(m_mu);
                if (m_fd < 0) return -1;
                continue;
            }
            return -1;
        }
    }

    bool readLine(std::string& line) {
        line.clear();
        char c;
        while (true) {
            int n = readRaw(&c, 1);
            if (n <= 0) return false;
            if (c == '\n') break;
            if (c != '\r') line.push_back(c);
            if (line.size() > 4096) return false;
        }
        return true;
    }

    bool consumeLine() {
        std::string ignored;
        return readLine(ignored);
    }

    std::mutex m_mu;
    int m_fd = -1;
    std::string m_pending;
    bool m_chunked = false;
    size_t m_chunkRemaining = 0;
    bool m_eof = false;
};

} // namespace

std::unique_ptr<HttpStream> createHttpStream() {
    return std::make_unique<PosixHttpStream>();
}

bool httpPost(const std::string& host, int port, const std::string& path,
              const std::vector<HttpHeader>& headers, const std::string& body, int* status) {
    int fd = connectTo(host, port, 2000);
    if (fd < 0) return false;
    std::string req = "POST " + path + " HTTP/1.1\r\nHost: " + host + ":" + std::to_string(port) +
                      "\r\nUser-Agent: ConstellationRenderer/1.0\r\nConnection: close\r\n" +
                      "Content-Length: " + std::to_string(body.size()) + "\r\n";
    for (const auto& h : headers) req += h.name + ": " + h.value + "\r\n";
    req += "\r\n" + body;
    bool ok = sendAll(fd, req);
    if (ok) {
        std::string hdrs, rest;
        ok = readHeaders(fd, hdrs, rest, 3000);
        if (ok && status) *status = parseStatus(hdrs);
    }
    ::close(fd);
    return ok;
}
