import { setFileServerBase, resolveUriSync } from '../media/uri.js'

// Re-export for backward compatibility. New code should import from media/uri.js directly.
export function setFileServerBaseUrl(url) {
  setFileServerBase(url)
}

export function resolveFileUrl(uri) {
  return resolveUriSync(uri)
}

export function getVideoMetadata(src) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    };
    video.onerror = () => {
      const err = new Error(describeMediaError(video.error));
      err.mediaErrorCode = video.error?.code;
      reject(err);
    };
    video.src = resolveFileUrl(src);
  });
}

/**
 * What a media element's error actually means, in words.
 *
 * `video.onerror` hands over an Event, which stringifies to "[object Event]";
 * the reason lives on `video.error`. Code 4 is the one that matters here: the
 * browser has no decoder for the codec, which is every HAP file and HEVC
 * without the codec pack.
 */
export function describeMediaError(mediaError) {
  switch (mediaError?.code) {
    case 1: return 'loading was aborted'
    case 2: return 'a network error interrupted loading'
    case 3: return 'the file is corrupt or truncated'
    case 4: return 'the browser cannot decode this codec'
    default: return 'the browser could not load it'
  }
}

/** True when the failure is the codec, not the file or the network. */
export function isCodecUnsupported(err) {
  return err?.mediaErrorCode === 4
}

/**
 * Ask the sidecar for a frame decoded by the native renderer.
 *
 * Used where the browser has given up: the renderer decodes HAP and HEVC,
 * so anything it can play, the media bin can preview. Resolves to a data
 * URL like the browser path does, so callers need not know which produced it.
 */
export async function fetchNativeThumbnail(src, time = 0) {
  const { getFileServerBase } = await import('../media/uri.js')
  const base = getFileServerBase()
  if (!base) throw new Error('no sidecar to ask for a native thumbnail')
  const u = String(src)
  if (u.startsWith('blob:') || u.startsWith('data:') || /^https?:/.test(u)) {
    throw new Error('native thumbnails need a file on disk')
  }
  const url = `${base}/api/thumbnail?uri=${encodeURIComponent(u)}&t=${encodeURIComponent(time)}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).trim()
    throw new Error(text || `native thumbnail failed (${res.status})`)
  }
  const blob = await res.blob()
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('could not read the native thumbnail'))
    reader.readAsDataURL(blob)
  })
}

export function generateVideoThumbnail(src, time = 0) {
  return generateBrowserThumbnail(src, time).catch(async (browserErr) => {
    // The browser is the fast path; the renderer is the one that can decode
    // everything the renderer can play. Fall through to it for any failure
    // on a local file, and report both reasons if it fails too.
    try {
      return await fetchNativeThumbnail(src, time)
    } catch (nativeErr) {
      const err = new Error(`${browserErr.message}; ${nativeErr.message}`)
      err.mediaErrorCode = browserErr.mediaErrorCode
      throw err
    }
  })
}

function generateBrowserThumbnail(src, time = 0) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    // Only set crossOrigin if not a blob/data URL to avoid issues with local resources
    if (!String(src).startsWith('blob:') && !String(src).startsWith('data:')) {
        video.crossOrigin = "anonymous";
    }
    video.preload = 'auto';
    
    const onComplete = () => {
        try {
            const canvas = document.createElement('canvas');
            const maxDim = 256;
            let w = video.videoWidth;
            let h = video.videoHeight;
            if (w > h) {
                if (w > maxDim) { h = h * (maxDim / w); w = maxDim; }
            } else {
                if (h > maxDim) { w = w * (maxDim / h); h = maxDim; }
            }
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg');
            resolve(dataUrl);
        } catch (e) {
            reject(e);
        } finally {
            video.removeAttribute('src');
            video.load();
        }
    };

    video.onloadeddata = () => {
        if (time === 0) {
            onComplete();
        } else {
            video.currentTime = time;
        }
    };

    video.onseeked = () => {
        onComplete();
    };
    
    video.onerror = () => {
      const err = new Error(describeMediaError(video.error));
      err.mediaErrorCode = video.error?.code;
      reject(err);
    };

    video.src = resolveFileUrl(src);
  });
}