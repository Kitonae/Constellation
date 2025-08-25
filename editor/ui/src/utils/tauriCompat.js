// Tauri compatibility helpers for opening dialogs from the Tauri shell.

import { open as tauriOpen } from '@tauri-apps/api/dialog'

const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }
const VIDEO_FILTER = { name: 'Videos', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', 'mpeg'] }
const ALL_FILTER = { name: 'All', extensions: ['*'] }

export async function openImageDialog() {
  // Use official Tauri API; works in the Tauri window.
  // If this throws in a plain browser, run inside Tauri.
  return await tauriOpen({ multiple: false, filters: [IMAGE_FILTER] })
}

export async function openMediaDialog() {
  // Allow selecting both images and videos
  return await tauriOpen({ multiple: false, filters: [ALL_FILTER, IMAGE_FILTER, VIDEO_FILTER] })
}
