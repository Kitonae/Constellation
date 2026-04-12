// Console/logging state slice

export function createConsoleSlice(set) {
  return {
    logs: [],
    consoleOpen: false,
    addLog: ({ level = 'info', message }) => set((s) => {
      const entry = {
        id: `log-${Math.random().toString(36).slice(2, 9)}`,
        level,
        message: String(message ?? ''),
        time: Date.now(),
      }
      const next = [...s.logs, entry]
      const pruned = next.length > 500 ? next.slice(next.length - 500) : next
      return { logs: pruned }
    }),
    clearLogs: () => set({ logs: [] }),
    toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),
  }
}
