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

struct Vec3 {
    double x = 0, y = 0, z = 0;
};

struct Quat {
    double x = 0, y = 0, z = 0, w = 1;
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

// Screen node state parsed from scene.roots[]
struct ScreenNode {
    std::string id;
    Vec2 position;       // viewport position
    Vec2 pixels;         // resolution (width, height)
    bool enabled = true;
};

// 3D model node parsed from scene.roots[]
struct ModelNode {
    std::string id;
    std::string name;
    std::string uri;
    Vec3 position;
    Quat rotation;
    Vec3 scale = { 1, 1, 1 };
};

// Scene manages the project state and evaluates the timeline.
class Scene {
public:
    void loadSnapshot(const nlohmann::json& data);
    std::vector<ActiveClip> evaluate(double time) const;

    const MediaClip* getMedia(const std::string& id) const;

    // Screen nodes from the scene tree
    const ScreenNode* getScreen(const std::string& id) const;
    const std::unordered_map<std::string, ScreenNode>& screens() const { return m_screens; }

    // 3D model nodes from the scene tree
    const std::unordered_map<std::string, ModelNode>& models() const { return m_models; }

private:
    std::unordered_map<std::string, MediaClip> m_media;
    std::vector<TimelineTrack> m_tracks;
    std::unordered_map<std::string, ScreenNode> m_screens;
    std::unordered_map<std::string, ModelNode> m_models;

    static TimelineClip parseTimelineClip(const nlohmann::json& j);
};
