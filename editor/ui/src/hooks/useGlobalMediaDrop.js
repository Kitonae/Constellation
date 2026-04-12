import { useEffect } from 'react'
import { useEditorStore } from '../store.js'
import { toFileUri } from '../utils/mediaUtils.js'
import { getVideoMetadata } from '../utils/videoUtils.js'
import { isMediaFile } from '../media/index.js'

export function useGlobalMediaDrop() {
  const addMediaClip = useEditorStore((s) => s.addMediaClip)

  useEffect(() => {
    const onDragOver = (e) => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onDrop = async (e) => {
      e.preventDefault()
      e.stopPropagation()
      const files = Array.from(e.dataTransfer.files || [])
      if (!files.length) return

      for (const file of files) {
        const name = file.name
        if (!isMediaFile(name) && !/\.(gltf|glb|obj)$/i.test(name)) continue

        const id = `clip-${Math.random().toString(36).slice(2, 8)}`
        let initialUri = null

        const path = file.path
        const isAbsolute = path && (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path))

        if (isAbsolute) {
          initialUri = toFileUri(path)
        } else if (file) {
          initialUri = URL.createObjectURL(file)
        }

        let duration = /\.(gltf|glb|obj)$/i.test(name) ? 0 : 10
        if (/\.(mp4|mov|webm|mkv|avi|m4v|mpg|mpeg)$/i.test(name)) {
          try {
            const meta = await getVideoMetadata(file || initialUri)
            if (meta?.duration) duration = meta.duration
          } catch (e) {
            console.warn('Failed to get video metadata', e)
          }
        }

        addMediaClip({ id, name, uri: initialUri, durationSeconds: duration })
      }
    }

    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [addMediaClip])
}
