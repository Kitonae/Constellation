package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// recorder collects the events a service emits, so a test can assert that the
// UI would actually have been told about a change.
type recorder struct {
	mu     sync.Mutex
	events []struct {
		name string
		data any
	}
}

func (r *recorder) sink() eventSink {
	return func(name string, data any) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, struct {
			name string
			data any
		}{name, data})
	}
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e.name == name {
			n++
		}
	}
	return n
}

func (r *recorder) last(name string) (any, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.events) - 1; i >= 0; i-- {
		if r.events[i].name == name {
			return r.events[i].data, true
		}
	}
	return nil, false
}

// newTestService keeps the recent-files list inside the test's own directory
// rather than the developer's real user profile.
func newTestService(t *testing.T) (*DocumentService, *recorder) {
	t.Helper()
	rec := &recorder{}
	return newDocumentServiceAt(rec.sink(), filepath.Join(t.TempDir(), "recent.json")), rec
}

// showJSON is a minimal valid show whose name and clip start distinguish one
// revision of it from another.
func showJSON(name string, clipStart float64) string {
	return `{"project":{"id":"p","name":"` + name + `","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[{"id":"c","clipId":"a","start":` +
		strconv.FormatFloat(clipStart, 'f', -1, 64) +
		`,"duration":5}]}]}}}`
}

func TestDocumentService_NewShowIsClean(t *testing.T) {
	// A show the operator has not touched is not unsaved work. If it read as
	// dirty, the first Quit would ask to discard nothing.
	svc, _ := newTestService(t)
	st := svc.State()
	if st.Dirty {
		t.Error("a freshly created show reports unsaved changes")
	}
	if st.Path != "" {
		t.Errorf("a new show should have no path, got %q", st.Path)
	}
	if st.Name != "Untitled" {
		t.Errorf("name = %q, want Untitled", st.Name)
	}
}

func TestDocumentService_UpdateMarksDirtyAndAnnounces(t *testing.T) {
	svc, rec := newTestService(t)
	before := rec.count(DocumentStateEvent)

	st, err := svc.Update([]byte(showJSON("Edited", 0)))
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !st.Dirty {
		t.Error("an edited show does not report unsaved changes")
	}
	if rec.count(DocumentStateEvent) != before+1 {
		t.Error("the editor was not told the document changed")
	}
}

func TestDocumentService_IdenticalUpdateDoesNotReannounce(t *testing.T) {
	// The editor sends the document on a debounce, so reopening a panel or
	// committing an Inspector field to its existing value arrives here as a
	// write. Treating that as a change would make a saved show look dirty.
	svc, rec := newTestService(t)
	content := showJSON("Same", 1)
	if _, err := svc.Update([]byte(content)); err != nil {
		t.Fatalf("Update: %v", err)
	}
	after := rec.count(DocumentStateEvent)

	if _, err := svc.Update([]byte(content)); err != nil {
		t.Fatalf("second Update: %v", err)
	}
	if rec.count(DocumentStateEvent) != after {
		t.Error("an update that changed nothing was announced as a change")
	}
}

func TestDocumentService_ReturningToSavedContentIsCleanAgain(t *testing.T) {
	// Dirty compares content, not events. Undoing back to the last saved
	// state must clear the dot; a boolean flag set on every write could not.
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "show.json")

	saved := showJSON("Show", 0)
	if _, err := svc.Update([]byte(saved)); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := svc.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if _, err := svc.Update([]byte(showJSON("Show", 3))); err != nil {
		t.Fatalf("edit: %v", err)
	}
	if !svc.State().Dirty {
		t.Fatal("an edit after saving does not report unsaved changes")
	}

	if _, err := svc.Update([]byte(saved)); err != nil {
		t.Fatalf("undo: %v", err)
	}
	if svc.State().Dirty {
		t.Error("returning to the saved content still reports unsaved changes")
	}
}

func TestDocumentService_UpdateRejectsInvalidAndKeepsTheGoodDocument(t *testing.T) {
	// A serialization bug must surface as an error, not as a Save that
	// silently writes the last document that happened to parse.
	svc, _ := newTestService(t)
	good := showJSON("Good", 0)
	if _, err := svc.Update([]byte(good)); err != nil {
		t.Fatalf("Update: %v", err)
	}

	if _, err := svc.Update([]byte(`{"project":"not an object"}`)); err == nil {
		t.Fatal("an invalid document was accepted")
	}
	if svc.State().Name != "Good" {
		t.Errorf("the good document was replaced, name = %q", svc.State().Name)
	}
	if !strings.Contains(svc.Contents(), `"Good"`) {
		t.Error("the good document's contents were lost")
	}
}

func TestDocumentService_SaveWithoutPathAsksForOne(t *testing.T) {
	svc, _ := newTestService(t)
	if _, err := svc.Save(); err == nil {
		t.Fatal("saving a show that has no file should report that it needs one")
	} else if err != ErrNoPath {
		t.Errorf("expected ErrNoPath, got %v", err)
	}
}

func TestDocumentService_SaveAsWritesAndBecomesClean(t *testing.T) {
	svc, _ := newTestService(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "opening.json")

	if _, err := svc.Update([]byte(showJSON("Opening", 2))); err != nil {
		t.Fatalf("Update: %v", err)
	}
	st, err := svc.SaveAs(path)
	if err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if st.Dirty {
		t.Error("the show still reports unsaved changes after being saved")
	}
	if st.Path != path {
		t.Errorf("path = %q, want %q", st.Path, path)
	}
	if st.FileName != "opening.json" {
		t.Errorf("fileName = %q, want opening.json", st.FileName)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the file was not written: %v", err)
	}
	if _, err := ParseDocument(raw); err != nil {
		t.Errorf("what was written is not a valid show: %v", err)
	}

	// An interrupted save must not leave its scratch file behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".constellation-save-") {
			t.Errorf("a temporary file was left behind: %s", e.Name())
		}
	}
}

func TestDocumentService_SaveAsAddsTheExtension(t *testing.T) {
	svc, _ := newTestService(t)
	st, err := svc.SaveAs(filepath.Join(t.TempDir(), "no-extension"))
	if err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if filepath.Ext(st.Path) != ".json" {
		t.Errorf("path = %q, expected a .json extension", st.Path)
	}
}

func TestDocumentService_SaveOverwritesTheSameFile(t *testing.T) {
	// This is the behaviour a browser download could not provide: the second
	// save replaced the first rather than producing "show (1).json".
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "show.json")

	if _, err := svc.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if _, err := svc.Update([]byte(showJSON("Second", 4))); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := svc.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if !strings.Contains(string(raw), "Second") {
		t.Error("the second save did not reach the original file")
	}
}

func TestDocumentService_OpenRoundTrip(t *testing.T) {
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "show.json")

	if _, err := svc.Update([]byte(showJSON("Round Trip", 7))); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := svc.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	saved := svc.Contents()

	// A different service, as if the application had been restarted.
	reopened, _ := newTestService(t)
	res, err := reopened.Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if res.Cancelled {
		t.Error("Open reported a cancellation")
	}
	if res.State.Dirty {
		t.Error("a freshly opened show reports unsaved changes")
	}
	if res.Contents != saved {
		t.Errorf("what was read back differs from what was written:\nwrote:\n%s\nread:\n%s", saved, res.Contents)
	}
	if res.State.Name != "Round Trip" {
		t.Errorf("name = %q, want Round Trip", res.State.Name)
	}
}

func TestDocumentService_OpenFailureKeepsTheOpenShow(t *testing.T) {
	// Half-loading someone else's broken file over the operator's work would
	// lose the work to a typo they did not make.
	svc, _ := newTestService(t)
	if _, err := svc.Update([]byte(showJSON("Mine", 1))); err != nil {
		t.Fatalf("Update: %v", err)
	}

	bad := filepath.Join(t.TempDir(), "broken.json")
	if err := os.WriteFile(bad, []byte(`{"project": `), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if _, err := svc.Open(bad); err == nil {
		t.Fatal("a truncated file was accepted")
	}
	if svc.State().Name != "Mine" {
		t.Errorf("the open show was replaced, name = %q", svc.State().Name)
	}
}

func TestDocumentService_OpenRejectsMissingAndDirectories(t *testing.T) {
	svc, _ := newTestService(t)
	dir := t.TempDir()

	if _, err := svc.Open(filepath.Join(dir, "nope.json")); err == nil {
		t.Error("opening a missing file was accepted")
	}
	if _, err := svc.Open(dir); err == nil {
		t.Error("opening a folder was accepted")
	}
	if _, err := svc.Open("not-absolute.json"); err == nil {
		t.Error("opening a relative path was accepted")
	}
}

func TestDocumentService_NewReplacesAndIsClean(t *testing.T) {
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "show.json")
	if _, err := svc.Update([]byte(showJSON("Old", 1))); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if _, err := svc.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}

	res, err := svc.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if res.State.Dirty {
		t.Error("a new show reports unsaved changes")
	}
	if res.State.Path != "" {
		t.Errorf("a new show inherited the previous file path %q", res.State.Path)
	}
	if res.State.Name != "Untitled" {
		t.Errorf("name = %q, want Untitled", res.State.Name)
	}
}

func TestDocumentService_RecentListsOpenedAndSaved(t *testing.T) {
	rec := &recorder{}
	recentPath := filepath.Join(t.TempDir(), "recent.json")
	svc := newDocumentServiceAt(rec.sink(), recentPath)

	dir := t.TempDir()
	first := filepath.Join(dir, "first.json")
	second := filepath.Join(dir, "second.json")
	if _, err := svc.SaveAs(first); err != nil {
		t.Fatalf("SaveAs first: %v", err)
	}
	if _, err := svc.SaveAs(second); err != nil {
		t.Fatalf("SaveAs second: %v", err)
	}

	got := svc.Recent()
	if len(got) != 2 || got[0] != second || got[1] != first {
		t.Errorf("recent = %v, want most recent first", got)
	}

	// Saving to the same file again moves it to the front rather than
	// listing it twice.
	if _, err := svc.SaveAs(first); err != nil {
		t.Fatalf("SaveAs first again: %v", err)
	}
	got = svc.Recent()
	if len(got) != 2 || got[0] != first {
		t.Errorf("recent = %v, want first moved to the front with no duplicate", got)
	}

	// A second session reads the list back from disk.
	restarted := newDocumentServiceAt(rec.sink(), recentPath)
	if persisted := restarted.Recent(); len(persisted) != 2 || persisted[0] != first {
		t.Errorf("recent did not persist between sessions: %v", persisted)
	}
}

func TestDocumentService_RecentDropsFilesThatAreGone(t *testing.T) {
	// A reopen menu that offers a moved file offers an action that can only
	// fail.
	rec := &recorder{}
	recentPath := filepath.Join(t.TempDir(), "recent.json")
	svc := newDocumentServiceAt(rec.sink(), recentPath)

	dir := t.TempDir()
	kept := filepath.Join(dir, "kept.json")
	removed := filepath.Join(dir, "removed.json")
	if _, err := svc.SaveAs(kept); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if _, err := svc.SaveAs(removed); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}
	if err := os.Remove(removed); err != nil {
		t.Fatalf("remove: %v", err)
	}

	restarted := newDocumentServiceAt(rec.sink(), recentPath)
	got := restarted.Recent()
	if len(got) != 1 || got[0] != kept {
		t.Errorf("recent = %v, want only the file that still exists", got)
	}
}

func TestDocumentService_RenameChangesTheShowNotTheFile(t *testing.T) {
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "cue-stack-v3.json")
	if _, err := svc.SaveAs(path); err != nil {
		t.Fatalf("SaveAs: %v", err)
	}

	st, err := svc.Rename("Opening")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if st.Name != "Opening" {
		t.Errorf("name = %q, want Opening", st.Name)
	}
	if st.FileName != "cue-stack-v3.json" {
		t.Errorf("renaming the show changed its file name to %q", st.FileName)
	}
	if !st.Dirty {
		t.Error("renaming the show is an edit and should report unsaved changes")
	}
}

func TestDocumentState_ReportsTheCurrentVersion(t *testing.T) {
	svc, _ := newTestService(t)
	if v := svc.State().Version; v != DocumentVersion {
		t.Errorf("version = %d, want %d", v, DocumentVersion)
	}
}

func TestDocumentService_EventCarriesTheState(t *testing.T) {
	svc, rec := newTestService(t)
	if _, err := svc.Update([]byte(showJSON("Announced", 2))); err != nil {
		t.Fatalf("Update: %v", err)
	}
	data, ok := rec.last(DocumentStateEvent)
	if !ok {
		t.Fatal("no document state event was emitted")
	}
	st, ok := data.(DocumentState)
	if !ok {
		t.Fatalf("event carried %T, want DocumentState", data)
	}
	if st.Name != "Announced" || !st.Dirty {
		t.Errorf("event carried %+v", st)
	}
}

func TestDocumentService_ReformattedNumbersAreNotAnEdit(t *testing.T) {
	// The editor serializes through JavaScript, so a file holding "1e3" comes
	// back as "1000". That is the same show. Comparing the bytes would report
	// unsaved changes on a document nobody had touched yet.
	svc, _ := newTestService(t)
	path := filepath.Join(t.TempDir(), "show.json")

	onDisk := `{"project":{"id":"p","name":"N","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[{"id":"c","clipId":"a","start":1e3,"duration":12.50}]}]}}}`
	if err := os.WriteFile(path, []byte(onDisk), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	if _, err := svc.Open(path); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if svc.State().Dirty {
		t.Fatal("a freshly opened show already reports unsaved changes")
	}

	fromEditor := `{"project":{"id":"p","name":"N","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[{"id":"c","clipId":"a","start":1000,"duration":12.5}]}]}}}`
	if _, err := svc.Update([]byte(fromEditor)); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if svc.State().Dirty {
		t.Error("re-spelling the same numbers was treated as an edit")
	}

	// A real change to the same field still registers.
	changed := `{"project":{"id":"p","name":"N","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[{"id":"c","clipId":"a","start":1001,"duration":12.5}]}]}}}`
	if _, err := svc.Update([]byte(changed)); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if !svc.State().Dirty {
		t.Error("an actual edit was not noticed")
	}
}

func TestDocument_BytesStillPreserveTheOriginalSpelling(t *testing.T) {
	// Identity is for comparison only. What gets written must still be what
	// was read, or opening a show and saving it would rewrite every number.
	doc := mustParse(t, `{"project":{"scene":{"roots":[]},"timeline":{"tracks":[{"media":[
	  {"id":"c","start":1e3,"duration":0.30000000000000004}]}]}}}`)
	raw, err := doc.Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	if !strings.Contains(string(raw), "1e3") || !strings.Contains(string(raw), "0.30000000000000004") {
		t.Errorf("numbers were rewritten on the way out:\n%s", raw)
	}
}
