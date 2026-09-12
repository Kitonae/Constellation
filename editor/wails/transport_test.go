package main

import (
	"encoding/json"
	"math"
	"testing"
	"time"
)

func newTestTransport(t *testing.T) (*Transport, *mockBroadcaster, *recorder) {
	t.Helper()
	hub := &mockBroadcaster{}
	rec := &recorder{}
	tr := NewTransport(hub, rec.sink())
	t.Cleanup(tr.Close)
	return tr, hub, rec
}

func TestTransport_StartsPausedAtZero(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	st := tr.State()
	if st.Playing {
		t.Error("a new transport is already running")
	}
	if st.Time != 0 {
		t.Errorf("time = %v, want 0", st.Time)
	}
	if st.Rate != 1 {
		t.Errorf("rate = %v, want 1", st.Rate)
	}
}

func TestTransport_PausedTimeDoesNotDrift(t *testing.T) {
	// The position of a paused show is a stored number, not a measurement.
	tr, _, _ := newTestTransport(t)
	tr.Seek(12.5)
	time.Sleep(40 * time.Millisecond)
	if got := tr.State().Time; got != 12.5 {
		t.Errorf("a paused transport moved to %v", got)
	}
}

func TestTransport_PlayAdvancesFromTheAnchor(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	tr.Seek(5)
	tr.Play()
	time.Sleep(120 * time.Millisecond)

	got := tr.State().Time
	// Generous bounds: this asserts that time advances from where it was and
	// roughly in real time, not that the scheduler is precise.
	if got < 5.05 || got > 5.6 {
		t.Errorf("time = %v after ~120ms of playback from 5, want a little past 5.1", got)
	}
}

func TestTransport_PauseHoldsWhereTheShowActuallyIs(t *testing.T) {
	// Clearing the run state before reading the position would return the
	// stale anchor, and the show would jump backwards every time it paused.
	tr, _, _ := newTestTransport(t)
	tr.Play()
	time.Sleep(120 * time.Millisecond)
	paused := tr.Pause()

	if paused.Playing {
		t.Error("still playing after pause")
	}
	if paused.Time < 0.05 {
		t.Errorf("pause rewound the show to %v", paused.Time)
	}
	time.Sleep(40 * time.Millisecond)
	if after := tr.State().Time; after != paused.Time {
		t.Errorf("a paused transport moved from %v to %v", paused.Time, after)
	}
}

func TestTransport_SeekKeepsRunState(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	tr.Play()
	st := tr.Seek(30)
	if !st.Playing {
		t.Error("seeking stopped playback")
	}
	if st.Time < 30 || st.Time > 30.1 {
		t.Errorf("time = %v, want 30", st.Time)
	}

	tr.Pause()
	if st := tr.Seek(10); st.Playing {
		t.Error("seeking started playback")
	}
}

func TestTransport_SeekClampsNonsense(t *testing.T) {
	// A half-typed Inspector field used to be able to put NaN into the
	// timeline, which made every downstream comparison false.
	tr, _, _ := newTestTransport(t)
	for _, bad := range []float64{-5, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if got := tr.Seek(bad).Time; got != 0 {
			t.Errorf("Seek(%v) gave time %v, want 0", bad, got)
		}
	}
}

func TestTransport_StopRewinds(t *testing.T) {
	tr, hub, _ := newTestTransport(t)
	tr.Play()
	time.Sleep(60 * time.Millisecond)
	st := tr.Stop()

	if st.Playing {
		t.Error("still playing after stop")
	}
	if st.Time != 0 {
		t.Errorf("time = %v after stop, want 0", st.Time)
	}
	if !hasControl(hub.controlLog(), "stop") {
		t.Errorf("renderers were not told to stop: %v", hub.controlLog())
	}
}

func TestTransport_SequenceIncreasesOnEveryChange(t *testing.T) {
	// A consumer uses this to discard a correction that overtook a newer one.
	tr, _, _ := newTestTransport(t)
	seen := tr.State().Seq
	for i, st := range []TransportState{tr.Play(), tr.Seek(4), tr.Pause(), tr.Stop()} {
		if st.Seq <= seen {
			t.Errorf("step %d: seq %d did not increase past %d", i, st.Seq, seen)
		}
		seen = st.Seq
	}
}

func TestTransport_RedundantPlayDoesNotReanchor(t *testing.T) {
	// Holding the space bar, or two components both calling play, must not
	// restart the clock.
	tr, _, _ := newTestTransport(t)
	tr.Play()
	time.Sleep(80 * time.Millisecond)
	before := tr.State().Time
	tr.Play()
	if after := tr.State().Time; after < before {
		t.Errorf("a second play rewound the show from %v to %v", before, after)
	}
}

func TestTransport_RateScalesAdvance(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	tr.Seek(0)
	tr.SetRate(4)
	tr.Play()
	time.Sleep(100 * time.Millisecond)

	got := tr.State().Time
	if got < 0.2 {
		t.Errorf("time = %v after ~100ms at 4x, expected roughly 0.4", got)
	}
}

func TestTransport_SetRateKeepsPosition(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	tr.Seek(9)
	if st := tr.SetRate(2); st.Time < 9 || st.Time > 9.1 {
		t.Errorf("changing rate moved the playhead to %v", st.Time)
	}
}

func TestTransport_SetRateRejectsNonsense(t *testing.T) {
	tr, _, _ := newTestTransport(t)
	for _, bad := range []float64{0, -2, math.NaN(), math.Inf(1)} {
		if got := tr.SetRate(bad).Rate; got != 1 {
			t.Errorf("SetRate(%v) gave rate %v, want 1", bad, got)
		}
	}
}

func TestTransport_PublishesToRenderersAndEditor(t *testing.T) {
	tr, hub, rec := newTestTransport(t)
	tr.Play()

	hub.mu.Lock()
	transports := len(hub.transports)
	hub.mu.Unlock()
	if transports == 0 {
		t.Error("no transport state reached the renderers")
	}
	if rec.count(TransportStateEvent) == 0 {
		t.Error("no transport state reached the editor")
	}
	if !hasControl(hub.controlLog(), "play") {
		t.Errorf("renderers were not told to play: %v", hub.controlLog())
	}
}

func TestTransport_PublishedPayloadIsCompleteState(t *testing.T) {
	// Corrections are latest-wins on the wire, so each one has to carry
	// everything a consumer needs rather than only what changed.
	tr, hub, _ := newTestTransport(t)
	tr.Seek(7.5)
	tr.Play()

	hub.mu.Lock()
	last := hub.transports[len(hub.transports)-1]
	hub.mu.Unlock()

	var st TransportState
	if err := json.Unmarshal(last, &st); err != nil {
		t.Fatalf("payload is not valid JSON: %v (%s)", err, last)
	}
	if !st.Playing {
		t.Error("payload does not say the show is running")
	}
	if st.Time < 7.5 {
		t.Errorf("payload time = %v, want at least 7.5", st.Time)
	}
	if st.Rate != 1 {
		t.Errorf("payload rate = %v, want 1", st.Rate)
	}
	if st.Seq == 0 {
		t.Error("payload has no sequence number")
	}
}

func TestTransport_CorrectsWhilePlayingAndIsQuietWhenPaused(t *testing.T) {
	// The point of corrections is that a consumer which has drifted, or which
	// connected late, is right again within a frame or two. A paused show has
	// nothing to correct and should say nothing.
	tr, hub, _ := newTestTransport(t)
	tr.Play()
	time.Sleep(3 * correctionInterval)

	hub.mu.Lock()
	playing := len(hub.transports)
	hub.mu.Unlock()
	if playing < 2 {
		t.Errorf("only %d transport messages during playback, expected corrections", playing)
	}

	tr.Pause()
	hub.mu.Lock()
	atPause := len(hub.transports)
	hub.mu.Unlock()

	time.Sleep(3 * correctionInterval)
	hub.mu.Lock()
	afterPause := len(hub.transports)
	hub.mu.Unlock()
	if afterPause != atPause {
		t.Errorf("a paused transport kept broadcasting: %d more messages", afterPause-atPause)
	}
}

func TestTransport_ResetReturnsToAStoppedShowAtZero(t *testing.T) {
	// New and Open used to leave the clock running, so the editor showed zero
	// while the session sat at the old position and still playing.
	tr, _, _ := newTestTransport(t)
	tr.SetRate(2)
	tr.Seek(42)
	tr.Play()

	st := tr.Reset()
	if st.Playing {
		t.Error("still playing after a document change")
	}
	if st.Time != 0 {
		t.Errorf("time = %v after a document change, want 0", st.Time)
	}
	if st.Rate != 1 {
		t.Errorf("rate = %v after a document change, want 1", st.Rate)
	}
}

func TestTransport_CloseIsIdempotent(t *testing.T) {
	tr := NewTransport(&mockBroadcaster{}, nil)
	tr.Close()
	tr.Close() // must not panic on a double close
}

func TestTransport_SurvivesNilCollaborators(t *testing.T) {
	// Constructed before the window exists, and in tests, so neither a hub
	// nor an event sink is guaranteed.
	tr := NewTransport(nil, nil)
	defer tr.Close()
	tr.Play()
	tr.Seek(3)
	tr.Pause()
	tr.Stop()
}

func hasControl(log []string, want string) bool {
	for _, c := range log {
		if c == want {
			return true
		}
	}
	return false
}
