#pragma once

#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>
#include <nlohmann/json.hpp>

struct MediaClip {
    std::string id;
    std::string name;
    std::string uri;
    double durationSeconds = 10.0;
};

struct Vec2 {
    double x = 0, y = 0;
};

struct EffectParams {
    bool enabled = false;
    double value = 0;
};

struct TimelineClip {
    std::string id;
    std::string clipId;
    double start = 0;
    double duration = 0;
    Vec2 position;
    Vec2 scale;       // 0 = use natural dimensions
    double opacity = 1.0;
    double fadeIn = 0;
    double fadeOut = 0;
    double blur = 0;  // legacy
    std::unordered_map<std::string, EffectParams> effects;
};

struct TimelineTrack {
    std::vector<TimelineClip> media;
};

struct ActiveClip {
    const TimelineClip* tm;
    const MediaClip* clip;
    double finalOpacity;    // pre-computed: base opacity * fade
};

// Scene manages the project state and evaluates the timeline.
class Scene {
public:
    void loadSnapshot(const nlohmann::json& data);
    std::vector<ActiveClip> evaluate(double time) const;

    const MediaClip* getMedia(const std::string& id) const;

private:
    std::unordered_map<std::string, MediaClip> m_media;
    std::vector<TimelineTrack> m_tracks;

    static TimelineClip parseTimelineClip(const nlohmann::json& j);
};
