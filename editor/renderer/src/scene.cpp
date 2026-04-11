#include "scene.h"
#include <algorithm>
#include <cmath>

using json = nlohmann::json;

void Scene::loadSnapshot(const json& data) {
    m_media.clear();
    m_tracks.clear();
    m_screens.clear();

    // Parse project wrapper: { project: { media: [...], timeline: { tracks: [...] }, scene: { roots: [...] } } }
    const json& proj = data.contains("project") ? data["project"] : data;

    // Parse screen nodes from scene.roots[]
    if (proj.contains("scene") && proj["scene"].contains("roots") && proj["scene"]["roots"].is_array()) {
        for (const auto& root : proj["scene"]["roots"]) {
            if (!root.contains("kind")) continue;
            const auto& kind = root["kind"];
            if (kind.value("type", "") != "screen") continue;

            ScreenNode sn;
            sn.id = root.value("id", "");
            if (sn.id.empty()) continue;

            if (root.contains("transform") && root["transform"].contains("position")) {
                const auto& pos = root["transform"]["position"];
                sn.position.x = pos.value("x", 0.0);
                sn.position.y = pos.value("y", 0.0);
            }

            if (kind.contains("pixels") && kind["pixels"].is_array() && kind["pixels"].size() >= 2) {
                sn.pixels.x = kind["pixels"][0].get<double>();
                sn.pixels.y = kind["pixels"][1].get<double>();
            }

            sn.enabled = kind.value("enabled", true);
            m_screens[sn.id] = sn;
        }
    }

    // Parse media
    if (proj.contains("media") && proj["media"].is_array()) {
        for (const auto& m : proj["media"]) {
            MediaClip clip;
            clip.id = m.value("id", "");
            clip.name = m.value("name", "");
            clip.uri = m.value("uri", "");
            clip.durationSeconds = m.value("duration_seconds", 10.0);
            if (!clip.id.empty()) {
                printf("[Scene] Media: id=%s name=%s uri=%.80s\n", clip.id.c_str(), clip.name.c_str(), clip.uri.c_str());
                m_media[clip.id] = std::move(clip);
            }
        }
    }

    printf("[Scene] Loaded %zu media clips\n", m_media.size());

    // Parse timeline tracks
    if (proj.contains("timeline") && proj["timeline"].contains("tracks")) {
        printf("[Scene] Loading %zu tracks\n", proj["timeline"]["tracks"].size());
        for (const auto& t : proj["timeline"]["tracks"]) {
            TimelineTrack track;
            const auto& mediaArr = t.contains("media") ? t["media"] : json::array();
            if (mediaArr.is_array()) {
                for (const auto& m : mediaArr) {
                    track.media.push_back(parseTimelineClip(m));
                }
            }
            m_tracks.push_back(std::move(track));
        }
    }
}

TimelineClip Scene::parseTimelineClip(const json& j) {
    TimelineClip c;
    c.id = j.value("id", "");
    c.clipId = j.value("clip_id", "");

    // Timing: prefer new fields, fall back to legacy
    c.start = j.value("start", j.value("start_at_seconds", 0.0));
    if (j.contains("duration")) {
        c.duration = j["duration"].get<double>();
    } else {
        double inSec = j.value("in_seconds", 0.0);
        double outSec = j.value("out_seconds", 0.0);
        c.duration = std::max(0.0, outSec - inSec);
    }

    // Position
    if (j.contains("position") && j["position"].is_object()) {
        c.position.x = j["position"].value("x", 0.0);
        c.position.y = j["position"].value("y", 0.0);
    }

    // Scale
    if (j.contains("scale") && j["scale"].is_object()) {
        c.scale.x = j["scale"].value("x", 0.0);
        c.scale.y = j["scale"].value("y", 0.0);
    }

    c.opacity = j.value("opacity", 1.0);
    c.fadeIn = j.value("fade_in", 0.0);
    c.fadeOut = j.value("fade_out", 0.0);
    c.blur = j.value("blur", 0.0);

    // Effects
    if (j.contains("effects") && j["effects"].is_object()) {
        for (auto& [key, val] : j["effects"].items()) {
            if (val.is_object()) {
                EffectParams ep;
                ep.enabled = val.value("enabled", false);
                ep.value = val.value("value", 0.0);
                c.effects[key] = ep;
            }
        }
    }

    return c;
}

std::vector<ActiveClip> Scene::evaluate(double time) const {
    std::vector<ActiveClip> result;

    static int evalCount = 0;
    bool verbose = (evalCount++ % 300 == 0); // log every ~5s at 60fps
    if (verbose) printf("[Scene] evaluate(t=%.3f) media=%zu tracks=%zu\n", time, m_media.size(), m_tracks.size());

    for (const auto& track : m_tracks) {
        const auto& mediaList = track.media;

        // Overlap detection (same algorithm as DisplayWindow.jsx)
        std::unordered_set<std::string> overlaps;
        for (size_t j = 0; j < mediaList.size(); j++) {
            for (size_t k = j + 1; k < mediaList.size(); k++) {
                const auto& m1 = mediaList[j];
                const auto& m2 = mediaList[k];
                double e1 = m1.start + m1.duration;
                double e2 = m2.start + m2.duration;
                if (m1.start < e2 && m2.start < e1) {
                    overlaps.insert(m1.id);
                    overlaps.insert(m2.id);
                }
            }
        }

        // Active clip resolution
        for (const auto& m : mediaList) {
            if (overlaps.count(m.id)) {
                if (verbose) printf("[Scene]   clip %s: OVERLAPPING, skipped\n", m.id.c_str());
                continue;
            }

            double end = m.start + m.duration;
            if (time < m.start || time > end) {
                if (verbose) printf("[Scene]   clip %s: out of range (t=%.3f, start=%.3f, end=%.3f)\n", m.id.c_str(), time, m.start, end);
                continue;
            }

            auto it = m_media.find(m.clipId);
            if (it == m_media.end()) {
                if (verbose) printf("[Scene]   clip %s: media %s NOT FOUND\n", m.id.c_str(), m.clipId.c_str());
                continue;
            }

            // Compute fade opacity
            double timeInClip = time - m.start;
            double fadeOpacity = 1.0;
            if (m.fadeIn > 0 && timeInClip < m.fadeIn) {
                fadeOpacity = std::clamp(timeInClip / m.fadeIn, 0.0, 1.0);
            } else if (m.fadeOut > 0 && timeInClip > m.duration - m.fadeOut) {
                fadeOpacity = std::clamp((m.duration - timeInClip) / m.fadeOut, 0.0, 1.0);
            }

            double finalOpacity = m.opacity * fadeOpacity;

            if (verbose) printf("[Scene]   clip %s: ACTIVE (opacity=%.2f, uri=%.60s)\n", m.id.c_str(), finalOpacity, it->second.uri.c_str());
            result.push_back(ActiveClip{&m, &it->second, finalOpacity});
        }
    }

    if (verbose) printf("[Scene] evaluate -> %zu active clips\n", result.size());
    return result;
}

const MediaClip* Scene::getMedia(const std::string& id) const {
    auto it = m_media.find(id);
    return it != m_media.end() ? &it->second : nullptr;
}

const ScreenNode* Scene::getScreen(const std::string& id) const {
    auto it = m_screens.find(id);
    return it != m_screens.end() ? &it->second : nullptr;
}
