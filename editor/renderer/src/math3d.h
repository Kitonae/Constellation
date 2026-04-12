#pragma once

// Lightweight 3D math helpers using DirectXMath for computation
// and plain float arrays for storage (avoids SIMD alignment issues).

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <DirectXMath.h>
#include <cmath>

using namespace DirectX;

struct Float4x4 {
    float m[16]; // row-major

    static Float4x4 identity() {
        Float4x4 r = {};
        r.m[0] = r.m[5] = r.m[10] = r.m[15] = 1.0f;
        return r;
    }
};

inline Float4x4 toFloat4x4(const XMMATRIX& mat) {
    Float4x4 r;
    XMFLOAT4X4 f;
    XMStoreFloat4x4(&f, mat);
    memcpy(r.m, &f, 64);
    return r;
}

inline XMMATRIX toXMMATRIX(const Float4x4& f) {
    XMFLOAT4X4 tmp;
    memcpy(&tmp, f.m, 64);
    return XMLoadFloat4x4(&tmp);
}

inline Float4x4 multiply(const Float4x4& a, const Float4x4& b) {
    return toFloat4x4(XMMatrixMultiply(toXMMATRIX(a), toXMMATRIX(b)));
}

inline Float4x4 perspectiveFovLH(float fovY, float aspect, float nearZ, float farZ) {
    return toFloat4x4(XMMatrixPerspectiveFovLH(fovY, aspect, nearZ, farZ));
}

inline Float4x4 lookAtLH(float eyeX, float eyeY, float eyeZ,
                          float targetX, float targetY, float targetZ,
                          float upX, float upY, float upZ) {
    XMVECTOR eye = XMVectorSet(eyeX, eyeY, eyeZ, 0);
    XMVECTOR target = XMVectorSet(targetX, targetY, targetZ, 0);
    XMVECTOR up = XMVectorSet(upX, upY, upZ, 0);
    return toFloat4x4(XMMatrixLookAtLH(eye, target, up));
}

inline Float4x4 fromQuaternion(double qx, double qy, double qz, double qw) {
    XMVECTOR q = XMVectorSet((float)qx, (float)qy, (float)qz, (float)qw);
    return toFloat4x4(XMMatrixRotationQuaternion(q));
}

inline Float4x4 composeTransform(double posX, double posY, double posZ,
                                  double qx, double qy, double qz, double qw,
                                  double scX, double scY, double scZ) {
    XMMATRIX S = XMMatrixScaling((float)scX, (float)scY, (float)scZ);
    XMVECTOR q = XMVectorSet((float)qx, (float)qy, (float)qz, (float)qw);
    XMMATRIX R = XMMatrixRotationQuaternion(q);
    XMMATRIX T = XMMatrixTranslation((float)posX, (float)posY, (float)posZ);
    // TRS order: scale, then rotate, then translate
    return toFloat4x4(XMMatrixMultiply(XMMatrixMultiply(S, R), T));
}

inline float toRadians(float degrees) {
    return degrees * 3.14159265358979f / 180.0f;
}
