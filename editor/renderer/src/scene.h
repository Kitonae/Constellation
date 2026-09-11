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
    // Overlaps only change when the snapshot changes, so they are resolved in
    // loadSnapshot instead of being recomputed quadratically every frame.
    bool overlapping = false;
};

struct TimelineTrack {
    std::vector<TimelineClip> media;
};

struct ActiveClip {
    const TimelineClip* tm;
    const MediaClip* clip;
    double finalOpacity;    // pre-computed: base opacity * fade
};

// Screen node state parsed from scene.roots[]
struct ScreenNode {
    std::string id;
    Vec2 position;       // viewport position
    Vec2 pixels;         // resolution (width, height)
    bool enabled = true;
};

// Scene manages the project state and evaluates the timeline.
class Scene {
public:
    void loadSnapshot(const nlohmann::json& data);
    std::vector<ActiveClip> evaluate(double time) const;

    const MediaClip* getMedia(const std::string& id) const;
    const std::unordered_map<std::string, MediaClip>& allMedia() const { return m_media; }
    const std::vector<TimelineTrack>& tracks() const { return m_tracks; }

    // Screen nodes from the scene tree
    const ScreenNode* getScreen(const std::string& id) const;
    const std::unordered_map<std::string, ScreenNode>& screens() const { return m_screens; }

private:
    static void markOverlaps(TimelineTrack& track);

    std::unordered_map<std::string, MediaClip> m_media;
    std::vector<TimelineTrack> m_tracks;
    std::unordered_map<std::string, ScreenNode> m_screens;

    static TimelineClip parseTimelineClip(const nlohmann::json& j);
};
