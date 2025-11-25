// Wails runtime API for communicating with Go backend

// Check if running under Wails
export const wailsAvailable = typeof window !== 'undefined' && window.go !== undefined

function fileUriToFsPath(uri) {
    try {
        const u = new URL(uri)
        if (u.protocol === 'file:') {
            // URL pathname on Windows starts with "/C:/..." — strip the leading slash
            return decodeURIComponent(u.pathname.replace(/^\//, ''))
        }
    } catch { }
    if (typeof uri === 'string' && uri.startsWith('file://')) {
        return decodeURIComponent(uri.replace(/^file:\/\//, ''))
    }
    return uri
}

export async function resolveMediaSrc(uri) {
    try {
        const p = fileUriToFsPath(String(uri || ''))
        if (!p) return null

        // In Wails, use the wails runtime to convert file paths
        if (wailsAvailable) {
            // Files are served directly via the asset server
            return `file://${p}`
        }

        return String(uri || '')
    } catch (e) {
        // Fallback to original URI
        return String(uri || '')
    }
}

// Placeholder functions for backward compatibility
// These will throw errors since the gRPC backend is removed
export async function applyProject(addr, json) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}

export async function play(addr, at = null) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}

export async function pause(addr) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}

export async function stop(addr) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}

export async function seek(addr, to) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}

export async function setRate(addr, rate) {
    throw new Error('gRPC functionality has been removed. Use the built-in display windows instead.')
}
