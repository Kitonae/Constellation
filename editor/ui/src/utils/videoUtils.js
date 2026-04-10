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
    video.onerror = (e) => {
      reject(e);
    };
    video.src = resolveFileUrl(src);
  });
}

export function generateVideoThumbnail(src, time = 0) {
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
    
    video.onerror = (e) => {
      reject(e);
    };

    video.src = resolveFileUrl(src);
  });
}