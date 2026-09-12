package main

// Transport bindings.
//
// Playback position used to be integrated in the browser by a
// requestAnimationFrame loop and pushed outward, which made the editor
// window's paint rate the show's timebase. These hand the decision to the
// shell; the editor and every renderer derive their own time from the state
// it reports.

// TransportPlay starts or resumes playback.
func (a *App) TransportPlay() TransportState {
	return a.transport.Play()
}

// TransportPause holds the playhead where it is.
func (a *App) TransportPause() TransportState {
	return a.transport.Pause()
}

// TransportStop halts playback and rewinds to the beginning.
func (a *App) TransportStop() TransportState {
	return a.transport.Stop()
}

// TransportSeek moves the playhead, keeping the current run state.
func (a *App) TransportSeek(seconds float64) TransportState {
	return a.transport.Seek(seconds)
}

// TransportSetRate changes playback speed, keeping the current position.
func (a *App) TransportSetRate(rate float64) TransportState {
	return a.transport.SetRate(rate)
}

// GetTransportState reports position and run state without changing them.
// The editor calls this once at startup and then follows transport:state.
func (a *App) GetTransportState() TransportState {
	return a.transport.State()
}
