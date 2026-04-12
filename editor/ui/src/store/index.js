// Editor store — composed from concern-based slices
//
// All slices share the same zustand store instance and can read/write
// any part of the state via the shared set/get functions.

import { create } from 'zustand'
import { createUndoStore, withUndo } from '../undo.js'
import { createProjectSlice } from './projectSlice.js'
import { createSceneSlice } from './sceneSlice.js'
import { createTransportSlice } from './transportSlice.js'
import { createUISlice } from './uiSlice.js'
import { createConsoleSlice } from './consoleSlice.js'
import { createImportSlice } from './importSlice.js'
import { setStoreRef } from './log.js'
import { setFileServerBaseUrl } from '../utils/videoUtils.js'
import { setFileServerBase } from '../media/uri.js'
import { createMediaSession } from '../media/session.js'
import { createNativeSink } from '../media/sink.js'
import { createProjectDocument } from '../project/projectCodec.js'

export const useEditorStore = create(withUndo((set, get, api) => ({
  ...createUndoStore(set, get, api),
  ...createConsoleSlice(set, get),
  ...createImportSlice(set, get),
  ...createUISlice(set, get),
  ...createSceneSlice(set, get),
  ...createProjectSlice(set, get),
  ...createTransportSlice(set, get, api, getMediaSession),
})))

// Wire up the log helper so slices can enqueue log entries
setStoreRef(useEditorStore)

// Expose for debugging
window.useEditorStore = useEditorStore

// Initialize file server base URL if in Wails environment
if (window.go?.main?.App?.GetFileServerPort) {
  window.go.main.App.GetFileServerPort().then(port => {
    if (port > 0) {
      console.log('Using sidecar file server at port', port)
      setFileServerBaseUrl(`http://localhost:${port}`)
      useEditorStore.setState({ _fileServerPort: port })
      setFileServerBase(`http://localhost:${port}`)
    }
  }).catch(err => console.warn('Failed to get file server port', err))
}

// --- Media Session singleton ---

let _mediaSession = null

export function getMediaSession() {
  if (!_mediaSession) {
    _mediaSession = createMediaSession({
      getStore: () => useEditorStore.getState(),
      broadcastFn: async (event, payload) => {
        try {
          const { broadcastToDisplays } = await import('../display/displayManager.js')
          broadcastToDisplays(event, payload)
        } catch { }
      },
      uiUpdateInterval: 16,
    })

    _mediaSession.subscribe({
      onTimeUpdate(time) {
        useEditorStore.setState({ time })
      },
      onStateChange(newState) {
        const playing = newState === 'playing'
        useEditorStore.setState({ playing })
      },
    })

    const nativeSink = createNativeSink({
      id: 'native-main',
      getSnapshot: () => {
        const s = useEditorStore.getState()
        if (!s.project) return null
        return createProjectDocument(s.project, s.scene)
      },
    })
    _mediaSession.addSink(nativeSink)
  }
  return _mediaSession
}
