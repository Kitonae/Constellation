#include "media_loader.h"
#include "image_io.h"
#include "platform.h"
#include "uri_util.h"

#include <cstdio>
#include <algorithm>

MediaLoader::~MediaLoader() { stop(); }

void MediaLoader::start() {
    if (m_running.exchange(true)) return;
    m_thread = std::thread(&MediaLoader::threadMain, this);
}

void MediaLoader::stop() {
    if (!m_running.exchange(false)) return;
    m_cv.notify_all();
    if (m_thread.joinable()) m_thread.join();
    std::lock_guard<std::mutex> lk(m_mu);
    m_queue.clear();
    m_ready.clear();
    m_known.clear();
}

void MediaLoader::requestImage(const std::string& uri) {
    if (uri.empty() || isRemoteUri(uri)) return;
    request(Request{false, uri, uri, {}});
}

void MediaLoader::requestVideo(const std::string& key, const std::string& uri,
                               const DecoderParams& params) {
    if (key.empty() || uri.empty() || isRemoteUri(uri)) return;
    request(Request{true, key, uri, params});
}

void MediaLoader::request(Request req) {
    std::lock_guard<std::mutex> lk(m_mu);
    auto it = m_known.find(req.key);
    if (it != m_known.end() && it->second.uri == req.uri) return;
    req.generation = ++m_nextGeneration;
    m_known[req.key] = {req.uri, req.generation};
    std::erase_if(m_queue, [&](const Request& old) { return old.key == req.key; });
    m_queue.push_back(std::move(req));
    m_cv.notify_one();
}

bool MediaLoader::isCurrent(const std::string& key, uint64_t generation) const {
    auto it = m_known.find(key);
    return it != m_known.end() && it->second.generation == generation;
}

void MediaLoader::forget(const std::string& key) {
    std::lock_guard<std::mutex> lk(m_mu);
    m_known.erase(key);
    std::erase_if(m_queue, [&](const Request& req) { return req.key == key; });
}

std::vector<MediaLoader::Ready> MediaLoader::drainReady() {
    std::vector<Ready> out;
    std::vector<Ready> stale;
    {
        std::lock_guard<std::mutex> lk(m_mu);
        for (auto& ready : m_ready) {
            (isCurrent(ready.key, ready.generation) ? out : stale).push_back(std::move(ready));
        }
        m_ready.clear();
    }
    // Closing a stale decoder joins its worker; do that outside the loader lock.
    return out;
}

void MediaLoader::threadMain() {
    platformThreadInit();

    while (m_running.load()) {
        Request req;
        {
            std::unique_lock<std::mutex> lk(m_mu);
            m_cv.wait(lk, [this] { return !m_queue.empty() || !m_running.load(); });
            if (!m_running.load()) break;
            req = std::move(m_queue.front());
            m_queue.pop_front();
        }

        Ready ready;
        ready.key = req.key;
        ready.uri = req.uri;
        ready.generation = req.generation;

        if (req.isVideo) {
            std::string path = uriToPath(req.uri);
            if (path.empty()) {
                ready.failed = true;
            } else {
                auto dec = std::make_unique<VideoDecoder>();
                dec->setVerbose(req.params.verbose);
                if (dec->open(path, req.params)) {
                    ready.decoder = std::move(dec);
                } else {
                    ready.failed = true;
                }
            }
        } else {
            if (!decodeImageFile(req.uri, ready)) ready.failed = true;
        }

        {
            std::lock_guard<std::mutex> lk(m_mu);
            if (isCurrent(req.key, req.generation)) m_ready.push_back(std::move(ready));
        }
    }

    platformThreadShutdown();
}

bool MediaLoader::decodeImageFile(const std::string& uri, Ready& out) {
    std::string path = uriToPath(uri);
    if (path.empty()) return false;
    return decodeImageFileRGBA(path, out.rgba, out.width, out.height);
}
