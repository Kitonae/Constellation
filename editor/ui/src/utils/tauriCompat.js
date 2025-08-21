// Tauri compatibility helpers for opening dialogs from the Tauri shell.

import { open as tauriOpen } from '@tauri-apps/api/dialog'

const IMAGE_FILTER = { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }

export async function openImageDialog() {
  // Use official Tauri API; works in the Tauri window.
  // If this throws in a plain browser, run inside Tauri.
  return await tauriOpen({ multiple: false, filters: [IMAGE_FILTER] })
}
