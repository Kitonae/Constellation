// Import progress tracking slice

import { queueLog } from './log.js'

export function createImportSlice(set) {
  return {
    _fileServerPort: 0,
    importingMediaCount: 0,
    importingMediaCountUpdatedAt: 0,
    importProgress: null,
    beginImport: () => set((s) => {
      const next = Math.max(0, (s.importingMediaCount || 0) + 1)
      console.debug('[import] begin ->', next)
      return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
    }),
    endImport: () => set((s) => {
      const next = Math.max(0, (s.importingMediaCount || 0) - 1)
      console.debug('[import] end ->', next)
      return { importingMediaCount: next, importingMediaCountUpdatedAt: Date.now() }
    }),
    resetImportingIfStuck: () => set((s) => {
      if (s.importingMediaCount > 0 && Date.now() - (s.importingMediaCountUpdatedAt || 0) > 15000) {
        queueLog('warn', 'Import appeared stuck >15s; auto-reset')
        console.warn('[import] auto-reset stuck imports')
        return { importingMediaCount: 0, importProgress: null }
      }
      return {}
    }),
    startImport: (total) => set({ importProgress: { current: 0, total, filename: '', cancelled: false } }),
    updateImportProgress: (current, filename) => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, current, filename } } : {}),
    cancelImport: () => set((s) => s.importProgress ? { importProgress: { ...s.importProgress, cancelled: true } } : {}),
    finishImport: () => set({ importProgress: null }),
  }
}
