// UI selection and view state slice

export function createUISlice(set) {
  return {
    viewMode: '2d',
    showOutputOverlay: true,
    selectedId: null,
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackIndex: null,
    gizmoMode: 'translate',
    setSelected: (id) => set({ selectedId: id }),
    setSelectedClip: (clipId) => set({ selectedClipId: clipId, selectedClipIds: clipId ? [clipId] : [] }),
    setSelectedClips: (clipIds) => set({ selectedClipIds: Array.isArray(clipIds) ? clipIds : [], selectedClipId: (clipIds && clipIds.length ? clipIds[0] : null) }),
    setSelectedTrackIndex: (index) => set({ selectedTrackIndex: index }),
    setGizmoMode: (mode) => set({ gizmoMode: mode }),
    setViewMode: (mode) => set({ viewMode: (mode === '3d' || mode === 'output') ? mode : '2d' }),
    toggleViewMode: () => set((s) => ({ viewMode: s.viewMode === '2d' ? '3d' : '2d' })),
    toggleOutputOverlay: () => set((s) => ({ showOutputOverlay: !s.showOutputOverlay })),
  }
}
