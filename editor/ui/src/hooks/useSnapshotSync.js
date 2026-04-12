import { useEffect, useRef } from 'react'
import { useEditorStore, getMediaSession } from '../store.js'

export function useSnapshotSync() {
  const project = useEditorStore((s) => s.project)
  const prevMediaRef = useRef(null)

  useEffect(() => {
    let projToSend = project
    if (project && project.media === prevMediaRef.current) {
      projToSend = { ...project, media: undefined }
    }
    prevMediaRef.current = project?.media
    try { getMediaSession().broadcastSnapshot({ project: projToSend }) } catch { }
  }, [project])
}
