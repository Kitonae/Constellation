// Playback transport slice

import { queueLog } from './log.js'

export function createTransportSlice(set, _get, _api, getSession) {
  return {
    time: 0,
    playing: false,
    play: () => {
      queueLog('info', 'Local: play')
      set({ playing: true })
      try { getSession().play() } catch {}
    },
    pause: () => {
      queueLog('info', 'Local: pause')
      set({ playing: false })
      try { getSession().pause() } catch {}
    },
    stop: () => {
      queueLog('info', 'Local: stop')
      set({ playing: false, time: 0 })
      try { getSession().stop() } catch {}
    },
    seek: (t) => {
      set({ time: t })
      try { getSession().seek(t) } catch {}
    },
  }
}
