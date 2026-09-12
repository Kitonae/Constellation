#pragma once
// One owned reference to an Objective-C or CoreFoundation object, usable from
// plain C++ headers. The shared code only ever stores and passes these; the
// .mm files bridge them back to typed pointers.

#include <CoreFoundation/CoreFoundation.h>
#include <utility>

class ObjcRef {
public:
    ObjcRef() = default;
    // Takes ownership of one +1 reference (CFBridgingRetain / CFRetain'ed).
    explicit ObjcRef(const void* retained) : m_ptr(retained) {}
    ObjcRef(const ObjcRef& o) : m_ptr(o.m_ptr) { if (m_ptr) CFRetain(m_ptr); }
    ObjcRef(ObjcRef&& o) noexcept : m_ptr(o.m_ptr) { o.m_ptr = nullptr; }
    ObjcRef& operator=(ObjcRef o) noexcept { std::swap(m_ptr, o.m_ptr); return *this; }
    ~ObjcRef() { if (m_ptr) CFRelease(m_ptr); }

    const void* get() const { return m_ptr; }
    explicit operator bool() const { return m_ptr != nullptr; }
    void reset() { if (m_ptr) CFRelease(m_ptr); m_ptr = nullptr; }
    bool operator==(const ObjcRef& o) const { return m_ptr == o.m_ptr; }
    bool operator!=(const ObjcRef& o) const { return m_ptr != o.m_ptr; }

private:
    const void* m_ptr = nullptr;
};

#ifdef __OBJC__
#import <Foundation/Foundation.h>
// Objective-C++ only: wrap and unwrap.
template <class T>
inline T objc(const ObjcRef& r) { return (__bridge T)r.get(); }
inline ObjcRef retainObjc(id object) { return ObjcRef(CFBridgingRetain(object)); }
#endif
