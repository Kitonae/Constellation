// The platform-neutral half of App: events, transport, media bookkeeping,
// the scene-to-quad mapping and the overlay text. Device setup, frame
// submission and windows live in win/app_win.cpp and mac/app_mac.mm.

#include "app.h"
#include "uri_util.h"
#include <cstdio>
#include <cmath>
#include <cctype>
#include <algorithm>
#include <unordered_set>
#include <vector>

// Advance the playhead from the last anchor the shell sent.
//
// This is what makes the picture independent of everything upstream: between
// corrections the show runs on this machine's own monotonic clock, so a busy
// editor, a slow link or a dropped message costs nothing visible.
void App::advanceTransport() {
    if (!m_transportDriven || !m_playing) {
        return;
    }
    const auto elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - m_transportAnchorAt).count();
    m_currentTime = m_transportAnchorTime + elapsed * m_transportRate;
}

void App::processEvents() {
    auto events = m_eventQueue.drainAll();
    m_eventsProcessed += (int)events.size();
    for (auto& event : events) {
        if (event.type == "snapshot") {
            m_scene.loadSnapshot(event.data);
            reconcileMedia();
            // The snapshot lists every asset, so start loading them now
            // instead of at the first frame each clip becomes active.
            prefetchMedia();
            printf("[App] Snapshot loaded\n");
        } else if (event.type == "transport") {
            // The authoritative run state and position. Each message states
            // the whole transport and they are latest-wins on the wire, so a
            // message that lost a race would otherwise drag the show back.
            unsigned long long seq = event.data.value("seq", 0ull);
            if (m_transportDriven && seq != 0 && seq < m_transportSeq) {
                continue;
            }
            m_transportSeq = seq;
            m_transportAnchorTime = event.data.value("time", 0.0);
            double rate = event.data.value("rate", 1.0);
            m_transportRate = (rate > 0.0) ? rate : 1.0;
            m_transportAnchorAt = std::chrono::steady_clock::now();
            m_playing = event.data.value("playing", false);
            m_transportDriven = true;
            m_currentTime = m_transportAnchorTime;
        } else if (event.type == "time") {
            // Superseded once an anchor has arrived. Applying the corrections
            // meant for an older shell would make the picture step at the
            // correction rate instead of running smoothly.
            if (!m_transportDriven) {
                m_currentTime = event.timeValue;
            }
        } else if (event.type == "control") {
            std::string cmd = event.data.is_string() ? event.data.get<std::string>() : "";
            // Run state travels with the anchor when one is driving; this is
            // kept for a shell that sends only the older events.
            if (!m_transportDriven) {
                if (cmd == "play") {
                    m_playing = true;
                } else if (cmd == "pause") {
                    m_playing = false;
                } else if (cmd == "stop") {
                    m_playing = false;
                    m_currentTime = 0;
                }
            }
            printf("[App] Control: %s\n", cmd.c_str());
        } else if (event.type == "screen-open") {
            std::string sid = event.data.value("screenId", "");
            int w = event.data.value("width", 1920);
            int h = event.data.value("height", 1080);
            ScreenPlacement placement;
            if (event.data.contains("x") && event.data.contains("y")) {
                placement.positioned = true;
                placement.x = event.data.value("x", 0);
                placement.y = event.data.value("y", 0);
            }
            placement.borderless = event.data.value("borderless", false);
            if (!sid.empty()) {
                handleScreenOpen(sid, w, h, placement);
            }
        } else if (event.type == "screen-close") {
            std::string sid = event.data.value("screenId", "");
            if (!sid.empty()) {
                handleScreenClose(sid);
            }
        }
    }
}

// --- Audio ---------------------------------------------------------------

// Players are keyed by timeline item, not by URI: two clips of the same file
// at different offsets need two players, and one shared player was asked for
// two different positions every frame.
void App::syncAudio(const std::vector<ActiveClip>& activeClips) {
    if (!m_config.audio) return;

    std::unordered_set<std::string> activeAudioKeys;

    for (const auto& ac : activeClips) {
        if (!ac.clip || ac.clip->uri.empty()) continue;
        const std::string& uri = ac.clip->uri;
        if (!isVideoFile(uri)) continue;
        if (isRemoteUri(uri)) continue;   // https: used to slip through here

        const std::string& key = ac.tm->id;
        activeAudioKeys.insert(key);
        AudioPlayer* audio = getAudioPlayer(key, uri);
        if (!audio) continue;

        const double timeInClip = m_currentTime - ac.tm->start + ac.tm->inSeconds;

        if (m_playing) {
            // Sync: if audio drifts >200ms from expected position, seek
            double drift = std::abs(audio->currentTime() - timeInClip);
            if (drift > 0.2) {
                if (m_config.verbose) printf("[Audio] %s drifted %.3fs, re-seeking to %.3f\n", key.c_str(), drift, timeInClip);
                audio->seek(timeInClip);
                m_lastAudioSeek[key] = timeInClip;
            }
            // Re-issuing play() after end of stream restarted it every frame
            if (!audio->isPlaying() && !audio->atEnd()) audio->play();
        } else {
            if (audio->isPlaying()) audio->pause();
            // Scrub: seek only when the playhead actually moved. This used
            // to fire every paused frame, and AudioPlayer::seek blocked on
            // the mutex the audio thread holds across Stop/Reset.
            auto lastIt = m_lastAudioSeek.find(key);
            if (lastIt == m_lastAudioSeek.end() || std::abs(lastIt->second - timeInClip) > (1.0 / 60.0)) {
                audio->seek(timeInClip);
                m_lastAudioSeek[key] = timeInClip;
            }
        }
    }

    // Pause audio for clips no longer active
    for (auto& [key, player] : m_audioPlayers) {
        if (player->isPlaying() && activeAudioKeys.find(key) == activeAudioKeys.end()) {
            player->pause();
        }
    }

    m_wasPlaying = m_playing;
}

// --- Quad constants --------------------------------------------------------

void App::buildQuadConstants(const ActiveClip& ac, float screenOffX, float screenOffY,
                             int screenW, int screenH, uint32_t texW, uint32_t texH,
                             float colorMode, TransformCB& transform, EffectsCB& effects) const {
    // Compute quad dimensions (scale 0 = natural size)
    float w = (ac.tm->scale.x > 0) ? (float)ac.tm->scale.x : (float)texW;
    float h = (ac.tm->scale.y > 0) ? (float)ac.tm->scale.y : (float)texH;

    transform = {};
    transform.position[0] = (float)ac.tm->position.x - screenOffX;
    transform.position[1] = (float)ac.tm->position.y - screenOffY;
    transform.scale[0] = w;
    transform.scale[1] = h;
    transform.screenSize[0] = (float)screenW;
    transform.screenSize[1] = (float)screenH;

    effects = {};
    effects.opacity = (float)ac.finalOpacity;
    effects.brightness = 1.0f;
    effects.contrast = 1.0f;
    effects.saturate_amount = 1.0f;
    effects.colorMode = colorMode;

    // Apply effects from clip
    for (const auto& [name, ep] : ac.tm->effects) {
        if (!ep.enabled) continue;
        if (name == "blur") effects.blur_radius = (float)ep.value;
        else if (name == "brightness") effects.brightness = (float)ep.value;
        else if (name == "contrast") effects.contrast = (float)ep.value;
        else if (name == "saturate") effects.saturate_amount = (float)ep.value;
        else if (name == "grayscale") effects.grayscale = (float)ep.value;
        else if (name == "sepia") effects.sepia = (float)ep.value;
        else if (name == "hue-rotate") effects.hue_rotate_deg = (float)ep.value;
        else if (name == "invert") effects.invert = (float)ep.value;
    }
    // Legacy blur
    if (ac.tm->blur > 0 && effects.blur_radius == 0) {
        effects.blur_radius = (float)ac.tm->blur;
    }
}

// --- Overlay and stats -----------------------------------------------------

void App::drawDebugOverlay(const std::string& screenId, int sw, int sh,
                           const std::vector<ActiveClip>& activeClips) {
    if (m_debugText.width() != (uint32_t)sw || m_debugText.height() != (uint32_t)sh) {
        m_debugText.init(sw, sh);
    }
    m_debugText.clear();

    bool connected = m_sseClient && m_sseClient->isConnected();
    m_debugText.drawFormat(8, 8,
        connected ? (uint8_t)0 : (uint8_t)255,
        connected ? (uint8_t)255 : (uint8_t)80,
        (uint8_t)0,
        "fps=%.0f  t=%.2fs  sse=%s  screen=%s (%dx%d)",
        m_fps, m_currentTime,
        connected ? "OK" : "DISCONNECTED",
        screenId.c_str(), sw, sh);
    // NDI status
    const char* ndiStatus = "off";
    int ndiConns = 0;
#if HAS_NDI
    if (m_ndiSender.isActive()) {
        ndiConns = m_ndiSender.numConnections();
        ndiStatus = m_ndiEnabled ? (ndiConns > 0 ? "streaming" : "ready") : "paused";
    }
#endif
    m_debugText.drawFormat(8, 20, 0, 255, 0, "playing=%s  clips=%zu  decoders=%zu  srv=%u  ndi=%s(%d)%s",
        m_playing ? "yes" : "no", activeClips.size(), m_videoDecoders.size(),
        m_textureCache.usedSlots(), ndiStatus, ndiConns,
        m_config.verbose ? "  [V]ERBOSE" : "");

    int ty = 34;
    for (const auto& ac : activeClips) {
        const char* name = ac.clip ? ac.clip->name.c_str() : "?";
        const std::string& auri = ac.clip ? ac.clip->uri : "";
        bool isBlob = isRemoteUri(auri);
        bool isVid = ac.clip && isVideoFile(auri);
        const char* tag = isBlob ? "[blob!]" : (isVid ? "[vid]" : "[img]");
        uint8_t cr = isBlob ? (uint8_t)255 : (uint8_t)200;
        uint8_t cg = isBlob ? (uint8_t)80 : (uint8_t)200;
        uint8_t cb = isBlob ? (uint8_t)80 : (uint8_t)200;
        m_debugText.drawFormat(8, ty, cr, cg, cb,
            " %s %s  op=%.0f%%  [%.1f-%.1f]",
            tag, name,
            ac.finalOpacity * 100.0, ac.tm->start, ac.tm->start + ac.tm->duration);
        ty += 12;

        // Video decoder stats
        if (isVid && !isBlob) {
            auto dit = m_videoDecoders.find(ac.tm->id);
            if (dit != m_videoDecoders.end() && dit->second->isOpen()) {
                auto* dec = dit->second.get();
                int shown = dec->displayedFrames();
                int drops = dec->playbackDrops();
                int decoded = dec->decodedFrames();
                int buf = dec->readableCount();
                int seeks = dec->seekCount();
                uint8_t dr = drops > 0 ? (uint8_t)255 : (uint8_t)120;
                uint8_t dg = drops > 0 ? (uint8_t)180 : (uint8_t)200;
                m_debugText.drawFormat(18, ty, dr, dg, 120,
                    "shown=%d drops=%d dec=%d buf=%d seeks=%d [%.0ffps %.1fms %s %s]",
                    shown, drops, decoded, buf, seeks, dec->fps(), dec->decodeMs(),
                    dec->codecName(), dec->accelLabel());
                ty += 12;
            }
        }
    }

    // Performance graphs (bottom-right corner)
    {
        int gw = 200, gh = 40, gpad = 6;
        int gx = sw - gw - 10;
        int gy = sh - (gh + gpad) * 3 - 10;
        // drawGraph labels with history[hi]; m_perfHead is the slot
        // about to be written, so the newest sample is one behind it.
        int hi = (m_perfHead + PERF_HISTORY - 1) % PERF_HISTORY;

        m_debugText.drawGraph(gx, gy, gw, gh,
            m_cpuFrameTimes, PERF_HISTORY, hi, 33.3f,
            0, 200, 255, "Frame");
        gy += gh + gpad;

        m_debugText.drawGraph(gx, gy, gw, gh,
            m_renderTimes, PERF_HISTORY, hi, 33.3f,
            100, 255, 50, "Render");
        gy += gh + gpad;

        m_debugText.drawGraph(gx, gy, gw, gh,
            m_videoDecodeTimes, PERF_HISTORY, hi, 16.6f,
            255, 180, 0, "Video");
    }
}

// Video decode cost, measured by the decode threads themselves.
float App::activeVideoDecodeMs(const std::vector<ActiveClip>& activeClips) const {
    float videoMs = 0;
    for (const auto& ac : activeClips) {
        if (!ac.clip || !isVideoFile(ac.clip->uri)) continue;
        auto dit = m_videoDecoders.find(ac.tm->id);
        if (dit != m_videoDecoders.end() && dit->second->isOpen())
            videoMs += (float)dit->second->decodeMs();
    }
    return videoMs;
}

void App::recordFrameStats(std::chrono::steady_clock::time_point cpuStart,
                           float renderMs, float videoMs) {
    m_renderTimes[m_perfHead % PERF_HISTORY] = renderMs;
    m_videoDecodeTimes[m_perfHead % PERF_HISTORY] = videoMs;

    // Frame stats: counted once per frame. Incrementing inside the screen
    // loop made the reported FPS scale with the number of open screens.
    m_frameCount++;
    {
        auto now = std::chrono::steady_clock::now();
        double statElapsed = std::chrono::duration<double>(now - m_lastStatTime).count();
        if (statElapsed >= 1.0) {
            m_fps = m_frameCount / statElapsed;
            printf("[App stats] fps=%.1f  events_processed=%d\n", m_fps, m_eventsProcessed);
            m_frameCount = 0;
            m_eventsProcessed = 0;
            m_lastStatTime = now;
        }
    }

    // Record CPU frame time and advance ring buffer
    auto cpuEnd = std::chrono::steady_clock::now();
    float cpuMs = (float)std::chrono::duration<double, std::milli>(cpuEnd - cpuStart).count();
    m_cpuFrameTimes[m_perfHead % PERF_HISTORY] = cpuMs;
    m_perfHead++;
}

// --- Media loading and eviction -----------------------------------------

void App::reconcileMedia() {
    std::unordered_map<std::string, std::string> current;
    for (const auto& track : m_scene.tracks()) {
        for (const auto& tm : track.media) {
            const auto* clip = m_scene.getMedia(tm.clipId);
            if (clip && isVideoFile(clip->uri) && !isRemoteUri(clip->uri))
                current[tm.id] = clip->uri;
        }
    }
    bool waited = false;
    for (const auto& [key, uri] : m_videoUris) {
        auto it = current.find(key);
        if (it != current.end() && it->second == uri) continue;
        // Invalidate pending requests even if no decoder has arrived yet.
        m_mediaLoader.forget(key);
        if (!waited) {
            waitForGpuIdle();
            waited = true;
        }
        m_videoDecoders.erase(key);
        m_audioPlayers.erase(key);
        m_lastAudioSeek.erase(key);
        m_mediaLastUsed.erase(key);
        m_textureCache.invalidate("__video_" + key, currentGarbage());
    }
    m_videoUris = std::move(current);
}

// Ask the loader for everything the snapshot references. Images are cheap to
// hold, so all of them are requested; decoders are not, so only clips near
// the playhead are opened ahead of time. Either way nothing is decoded on the
// render thread the moment a clip becomes active.
void App::prefetchMedia() {
    for (const auto& [id, clip] : m_scene.allMedia()) {
        if (clip.uri.empty() || isRemoteUri(clip.uri)) continue;
        if (TextureCache::isDataUri(clip.uri)) continue;   // decoded inline
        if (!isVideoFile(clip.uri)) m_mediaLoader.requestImage(clip.uri);
    }
    prefetchNearbyVideos();
}

void App::prefetchNearbyVideos() {
    static constexpr double PREFETCH_SECONDS = 30.0;
    for (const auto& track : m_scene.tracks()) {
        for (const auto& tm : track.media) {
            if (tm.overlapping) continue;
            double end = tm.start + tm.duration;
            if (end < m_currentTime || tm.start > m_currentTime + PREFETCH_SECONDS) continue;
            const MediaClip* clip = m_scene.getMedia(tm.clipId);
            if (!clip || clip->uri.empty() || isRemoteUri(clip->uri)) continue;
            if (!isVideoFile(clip->uri)) continue;
            if (m_videoDecoders.count(tm.id)) continue;
            m_mediaLoader.requestVideo(tm.id, clip->uri, decoderParams());
        }
    }
}

void App::drainLoader() {
    prefetchNearbyVideos();

    for (auto& ready : m_mediaLoader.drainReady()) {
        if (ready.failed) {
            fprintf(stderr, "[App] Failed to load %.80s\n", ready.uri.c_str());
            continue;
        }
        if (ready.decoder) {
            auto it = m_videoUris.find(ready.key);
            if (it == m_videoUris.end() || it->second != ready.uri) continue;
            m_videoDecoders[ready.key] = std::move(ready.decoder);
            m_mediaLastUsed[ready.key] = m_frameCounter;
        } else if (!ready.rgba.empty()) {
            m_textureCache.uploadPixels(ready.key, ready.rgba.data(),
                ready.width, ready.height, PixelFormat::RGBA8);
        }
    }
}

void App::evictUnusedMedia() {
    // Roughly five seconds at 60 fps: long enough that scrubbing back and
    // forth over a cut does not thrash, short enough to bound the SRV heap.
    static constexpr uint64_t GRACE_FRAMES = 300;
    if (m_frameCounter < GRACE_FRAMES) return;
    if ((m_frameCounter % 60) != 0) return;   // once a second is plenty

    FrameGarbage& garbage = currentGarbage();
    std::vector<std::string> evicted;
    m_textureCache.evictUnused(m_frameCounter, GRACE_FRAMES, garbage, &evicted);
    for (const auto& key : evicted) m_mediaLoader.forget(key);

    for (auto it = m_mediaLastUsed.begin(); it != m_mediaLastUsed.end(); ) {
        if (it->second + GRACE_FRAMES >= m_frameCounter) { ++it; continue; }
        const std::string key = it->first;
        // Closing a decoder joins its thread and returns its GPU frames, so
        // the render queue must be past every frame that sampled them.
        auto dit = m_videoDecoders.find(key);
        if (dit != m_videoDecoders.end()) {
            waitForGpuIdle();
            m_videoDecoders.erase(dit);
        }
        m_audioPlayers.erase(key);
        m_lastAudioSeek.erase(key);
        m_mediaLoader.forget(key);
        it = m_mediaLastUsed.erase(it);
    }
}

VideoDecoder* App::findVideoDecoder(const std::string& key) {
    auto it = m_videoDecoders.find(key);
    if (it == m_videoDecoders.end()) return nullptr;
    return it->second->isOpen() ? it->second.get() : nullptr;
}

std::string App::textureKeyFor(const std::string& clipId, const std::string& uri) {
    // A data: URI can be megabytes long; hashing it on every map lookup, and
    // storing it as a key, is pure waste when the clip id already identifies it.
    return TextureCache::isDataUri(uri) ? ("__img_" + clipId) : uri;
}

bool App::isVideoFile(const std::string& uri) {
    size_t dot = uri.rfind('.');
    if (dot == std::string::npos) return false;
    std::string ext = uri.substr(dot + 1);
    for (auto& c : ext) c = (char)std::tolower((unsigned char)c);
    return ext == "mp4" || ext == "mov" || ext == "webm" || ext == "mkv" ||
           ext == "avi" || ext == "m4v" || ext == "mpg" || ext == "mpeg" ||
           ext == "hevc" || ext == "h265" || ext == "265" || ext == "ts" || ext == "mts";
}

AudioPlayer* App::getAudioPlayer(const std::string& key, const std::string& uri) {
    auto it = m_audioPlayers.find(key);
    if (it != m_audioPlayers.end()) {
        return it->second->isOpen() ? it->second.get() : nullptr;
    }

    std::string path = uriToPath(uri);
    if (path.empty()) return nullptr;

    auto player = std::make_unique<AudioPlayer>();
    if (!player->open(path)) {
        m_audioPlayers[key] = std::move(player); // cache failure
        return nullptr;
    }

    AudioPlayer* ptr = player.get();
    m_audioPlayers[key] = std::move(player);
    return ptr;
}
