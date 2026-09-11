#pragma once
// Shared URI helpers.
//
// The file:/// decode was previously copy-pasted three times (App::getVideoDecoder,
// App::getAudioPlayer, TextureCache::uriToPath) and the "skip remote URIs" test
// existed in the render loop but not the audio loop, so an https: video still
// spawned a failing audio player.

#include <string>
#include <cstdlib>

// Convert a media URI to a local Windows path. Returns "" when the URI does
// not name a local file (blob:, http:, data:, ...).
inline std::string uriToPath(const std::string& uri) {
    auto urlDecode = [](const std::string& in, bool toBackslash) {
        std::string out;
        out.reserve(in.size());
        for (size_t i = 0; i < in.size(); i++) {
            if (in[i] == '%' && i + 2 < in.size()) {
                char hex[3] = { in[i + 1], in[i + 2], 0 };
                out += (char)strtol(hex, nullptr, 16);
                i += 2;
            } else if (toBackslash && in[i] == '/') {
                out += '\\';
            } else {
                out += in[i];
            }
        }
        return out;
    };

    // file:///C:/path/to/file.mp4
    if (uri.compare(0, 8, "file:///") == 0) {
        return urlDecode(uri.substr(8), true);
    }
    // file://host/path (POSIX-style, no drive letter)
    if (uri.compare(0, 7, "file://") == 0) {
        return urlDecode(uri.substr(7), false);
    }
    // Already a Windows path: C:\... or C:/...
    if (uri.size() > 2 && uri[1] == ':') {
        return uri;
    }
    return "";
}

// True for URIs the native renderer cannot open from disk.
inline bool isRemoteUri(const std::string& uri) {
    return uri.compare(0, 5, "blob:") == 0
        || uri.compare(0, 5, "http:") == 0
        || uri.compare(0, 6, "https:") == 0;
}
