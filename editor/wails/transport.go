package main

import (
	"encoding/json"
	"math"
	"sync"
	"time"
)

// TransportStateEvent carries the authoritative transport to the editor.
const TransportStateEvent = "transport:state"

// correctionInterval is how often a running transport re-states where it is.
//
// This is a correction, not a heartbeat that drives anything: every consumer
// advances its own time between messages from the anchor it was last given.
// Ten a second is frequent enough that a renderer joining mid-show, or one
// whose local clock has drifted, is right again within a frame or two, and
// sparse enough that the event stream is no longer the 60-per-second flood
// the browser used to produce.
const correctionInterval = 100 * time.Millisecond

// TransportState is where the show is and whether it is running.
//
// Time is the timeline position at the instant the state was issued. A
// consumer advances locally from there -- time + (now - receipt) * rate while
// playing -- rather than waiting to be told each new position, so a stalled
// editor, a throttled webview or a dropped message can no longer stall the
// picture on stage.
type TransportState struct {
	Playing bool    `json:"playing"`
	Time    float64 `json:"time"`
	Rate    float64 `json:"rate"`
	// Seq increases on every change. A consumer that receives an older Seq
	// than the one it holds is looking at a message that overtook a newer
	// one and must ignore it.
	Seq uint64 `json:"seq"`
}

// Transport owns playback position and run state for the whole application.
//
// It used to live in the browser: a requestAnimationFrame loop integrated
// wall-clock deltas and pushed the result to every output. That made the
// editor window's paint rate the show's timebase, so occluding or minimising
// the editor slowed or froze native output. Here the position is derived from
// a monotonic anchor instead, and the UI becomes another consumer of it.
type Transport struct {
	mu         sync.Mutex
	playing    bool
	rate       float64
	anchorTime float64
	anchorWall time.Time
	seq        uint64

	hub  Broadcaster
	emit eventSink

	stop     chan struct{}
	stopOnce sync.Once
}

// NewTransport starts a paused transport at zero and begins issuing
// corrections while it runs.
func NewTransport(hub Broadcaster, emit eventSink) *Transport {
	t := &Transport{
		rate:       1,
		anchorWall: time.Now(),
		hub:        hub,
		emit:       emit,
		stop:       make(chan struct{}),
	}
	go t.correct()
	return t
}

// Close stops the correction loop.
func (t *Transport) Close() {
	t.stopOnce.Do(func() { close(t.stop) })
}

// correct re-states a running transport at a steady rate.
func (t *Transport) correct() {
	ticker := time.NewTicker(correctionInterval)
	defer ticker.Stop()
	for {
		select {
		case <-t.stop:
			return
		case <-ticker.C:
			t.mu.Lock()
			running := t.playing
			st := t.state()
			t.mu.Unlock()
			if running {
				t.publish(st)
			}
		}
	}
}

// state reads the current position. Caller must hold the lock.
func (t *Transport) state() TransportState {
	return TransportState{
		Playing: t.playing,
		Time:    t.now(),
		Rate:    t.rate,
		Seq:     t.seq,
	}
}

// now is the timeline position this instant. Caller must hold the lock.
//
// time.Since reads Go's monotonic clock, so the show does not jump when the
// machine's wall clock is corrected by NTP or a daylight-saving change
// mid-performance.
func (t *Transport) now() float64 {
	if !t.playing {
		return t.anchorTime
	}
	return t.anchorTime + time.Since(t.anchorWall).Seconds()*t.rate
}

// reanchor pins the current position to this instant and bumps the sequence.
// Caller must hold the lock.
func (t *Transport) reanchor(at float64) {
	if math.IsNaN(at) || math.IsInf(at, 0) || at < 0 {
		at = 0
	}
	t.anchorTime = at
	t.anchorWall = time.Now()
	t.seq++
}

// publish sends one state to the renderers and to the editor.
func (t *Transport) publish(st TransportState) {
	if t.hub != nil {
		if payload, err := json.Marshal(st); err == nil {
			t.hub.BroadcastTransport(payload)
		}
		// Older renderer builds have no transport handling and advance only
		// when told a position. Keeping this going costs one small message
		// per correction and means a mismatched pair of binaries still plays;
		// a renderer that understands transport ignores it.
		t.hub.BroadcastTime(st.Time)
	}
	if t.emit != nil {
		t.emit(TransportStateEvent, st)
	}
}

// apply mutates under the lock, then publishes outside it. Publishing while
// holding the lock would let a slow SSE consumer block the next transport
// command.
func (t *Transport) apply(fn func()) TransportState {
	t.mu.Lock()
	fn()
	st := t.state()
	t.mu.Unlock()
	t.publish(st)
	return st
}

// Play starts or resumes from the current position.
func (t *Transport) Play() TransportState {
	return t.apply(func() {
		if t.playing {
			return
		}
		t.reanchor(t.anchorTime)
		t.playing = true
		if t.hub != nil {
			t.hub.BroadcastControl("play")
		}
	})
}

// Pause holds at the current position.
func (t *Transport) Pause() TransportState {
	return t.apply(func() {
		if !t.playing {
			return
		}
		// Anchor at where the show actually is before clearing the flag:
		// reading now() after playing is false would return the stale anchor
		// and the show would jump backwards on pause.
		t.reanchor(t.now())
		t.playing = false
		if t.hub != nil {
			t.hub.BroadcastControl("pause")
		}
	})
}

// Stop halts and rewinds to the beginning.
func (t *Transport) Stop() TransportState {
	return t.apply(func() {
		t.reanchor(0)
		t.playing = false
		if t.hub != nil {
			t.hub.BroadcastControl("stop")
		}
	})
}

// Seek moves the playhead, keeping the current run state.
func (t *Transport) Seek(sec float64) TransportState {
	return t.apply(func() { t.reanchor(sec) })
}

// SetRate changes playback speed, keeping the current position.
func (t *Transport) SetRate(rate float64) TransportState {
	return t.apply(func() {
		if math.IsNaN(rate) || math.IsInf(rate, 0) || rate <= 0 {
			rate = 1
		}
		t.reanchor(t.now())
		t.rate = rate
	})
}

// State reports the transport without changing it.
func (t *Transport) State() TransportState {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state()
}

// Reset returns the transport to a stopped show at zero without announcing a
// control command, for use when the document itself is being replaced.
//
// New and Open used to leave the clock running: the editor showed zero while
// the session sat at the old position and still playing, and the next tick
// carried that old position to every output.
func (t *Transport) Reset() TransportState {
	return t.apply(func() {
		t.reanchor(0)
		t.playing = false
		t.rate = 1
		if t.hub != nil {
			t.hub.BroadcastControl("stop")
		}
	})
}
