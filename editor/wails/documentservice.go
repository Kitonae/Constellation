package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// maxRecentDocuments is how many shows the File menu offers to reopen.
const maxRecentDocuments = 10

// DocumentStateEvent is emitted to the frontend whenever the open document,
// its path or its modified state changes. The editor renders from it rather
// than tracking any of this itself.
const DocumentStateEvent = "document:state"

// DocumentState is everything the UI needs to describe the open document: the
// window title, the File menu's enabled items and the dirty dot in the status
// bar all come from these five fields.
type DocumentState struct {
	// Path is empty for a show that has never been saved, which is what makes
	// Save fall through to Save As.
	Path string `json:"path"`
	// FileName is the base name of Path, or "" for an unsaved show.
	FileName string `json:"fileName"`
	// Name is the show's own name, which survives a Save As to a new file.
	Name string `json:"name"`
	// Dirty compares content, not events: undoing back to the last saved
	// state correctly reports clean again.
	Dirty   bool `json:"dirty"`
	Version int  `json:"version"`
}

// OpenedDocument carries a freshly loaded show and its state in one call, so
// the editor never has to ask for the contents separately and risk rendering
// a title for a document it has not received.
type OpenedDocument struct {
	State    DocumentState `json:"state"`
	Contents string        `json:"contents"`
	// Cancelled reports that the operator dismissed the file dialog. It is
	// not an error, and the editor must leave the open show alone.
	Cancelled bool `json:"cancelled"`
}

// SavedDocument is the result of a save, with the same cancellation rule as
// OpenedDocument: a dismissed Save As dialog is a decision, not a failure.
type SavedDocument struct {
	State     DocumentState `json:"state"`
	Cancelled bool          `json:"cancelled"`
}

// eventSink is how the service announces state changes. A function rather
// than the Wails app so the tests can observe emissions directly.
type eventSink func(name string, data any)

// DocumentService owns the open show: which file it came from, whether it has
// unsaved changes, and the canonical bytes to write back.
//
// The editor still performs the edits -- routing every drag through IPC would
// be far slower than a local store write -- but it no longer decides what a
// document is, where it lives or when it is dirty. It sends the document here
// after each change and reads this state back.
type DocumentService struct {
	mu        sync.Mutex
	doc       *Document
	canonical []byte
	hash      [32]byte
	savedHash [32]byte
	path      string
	recent    []string
	emit      eventSink

	// Where the recent-files list persists. A field rather than a constant so
	// a test can keep its bookkeeping out of the real user profile.
	recentPath string
}

// NewDocumentService starts on an empty untitled show, so the editor has a
// valid document before the window opens.
func NewDocumentService(emit eventSink) *DocumentService {
	return newDocumentServiceAt(emit, recentDocumentsPath())
}

func newDocumentServiceAt(emit eventSink, recentPath string) *DocumentService {
	s := &DocumentService{emit: emit, recentPath: recentPath}
	s.recent = loadRecentDocuments(recentPath)
	doc := NewDocument("Untitled")
	// A brand new show is not unsaved work: adopting its own bytes as the
	// saved baseline is what stops the first Quit asking to discard nothing.
	_ = s.adopt(doc, "", true)
	return s
}

// adopt installs a document as the current one. Caller must hold the lock, or
// be the constructor. markSaved makes the new content the clean baseline.
func (s *DocumentService) adopt(doc *Document, path string, markSaved bool) error {
	raw, err := doc.Bytes()
	if err != nil {
		return fmt.Errorf("serialize document: %w", err)
	}
	// Hashed over the document's meaning rather than its bytes, so a number
	// that merely came back from the editor spelled differently does not make
	// an untouched show report unsaved changes.
	identity, err := doc.Identity()
	if err != nil {
		return fmt.Errorf("compare document: %w", err)
	}
	s.doc = doc
	s.canonical = raw
	s.hash = sha256.Sum256(identity)
	if markSaved {
		s.savedHash = s.hash
	}
	s.path = path
	return nil
}

// state builds the current DocumentState. Caller must hold the lock.
func (s *DocumentService) state() DocumentState {
	name := ""
	if s.doc != nil {
		name = s.doc.Name()
	}
	file := ""
	if s.path != "" {
		file = filepath.Base(s.path)
	}
	return DocumentState{
		Path:     s.path,
		FileName: file,
		Name:     name,
		Dirty:    s.hash != s.savedHash,
		Version:  DocumentVersion,
	}
}

// announce emits the current state. Caller must hold the lock.
func (s *DocumentService) announce() DocumentState {
	st := s.state()
	if s.emit != nil {
		s.emit(DocumentStateEvent, st)
	}
	return st
}

// State reports the open document without changing anything.
func (s *DocumentService) State() DocumentState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state()
}

// Contents is the canonical serialization of the open document.
func (s *DocumentService) Contents() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return string(s.canonical)
}

// New replaces the open document with an empty show.
//
// It does not ask about unsaved work: the caller decides that, because only
// the UI can put the question to the operator.
func (s *DocumentService) New() (OpenedDocument, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.adopt(NewDocument("Untitled"), "", true); err != nil {
		return OpenedDocument{}, err
	}
	return OpenedDocument{State: s.announce(), Contents: string(s.canonical)}, nil
}

// Open reads, validates and migrates a show file, and makes it current.
//
// A file that fails to parse leaves the open document untouched: half-loading
// a show over a good one would lose the operator's work to a typo in someone
// else's file.
func (s *DocumentService) Open(path string) (OpenedDocument, error) {
	clean := filepath.Clean(path)
	if err := validateFSPath(clean); err != nil {
		return OpenedDocument{}, fmt.Errorf("invalid path: %w", err)
	}
	info, err := os.Stat(clean)
	if err != nil {
		return OpenedDocument{}, fmt.Errorf("cannot open %s: %w", filepath.Base(clean), err)
	}
	if info.IsDir() {
		return OpenedDocument{}, fmt.Errorf("%s is a folder, not a show file", filepath.Base(clean))
	}
	raw, err := os.ReadFile(clean)
	if err != nil {
		return OpenedDocument{}, fmt.Errorf("cannot read %s: %w", filepath.Base(clean), err)
	}
	doc, err := ParseDocument(raw)
	if err != nil {
		return OpenedDocument{}, fmt.Errorf("%s is not a valid show: %w", filepath.Base(clean), err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.adopt(doc, clean, true); err != nil {
		return OpenedDocument{}, err
	}
	s.pushRecent(clean)
	return OpenedDocument{State: s.announce(), Contents: string(s.canonical)}, nil
}

// Update records an edited document from the editor.
//
// This is the one call the editor makes after every committed change. It is
// what keeps the dirty flag, the saveable bytes and the renderers' snapshot
// in agreement; before it, each of those was tracked somewhere different.
//
// Invalid content is rejected rather than stored, so a serialization bug
// surfaces immediately instead of turning the next Save into a silent no-op
// that writes the last good document.
func (s *DocumentService) Update(raw []byte) (DocumentState, error) {
	doc, err := ParseDocument(raw)
	if err != nil {
		return s.State(), fmt.Errorf("editor sent an invalid document: %w", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.hash
	if err := s.adopt(doc, s.path, false); err != nil {
		return s.state(), err
	}
	if s.hash == prev {
		// A debounced edit that changed nothing -- reopening a panel, a
		// no-op Inspector commit -- must not re-announce and must not make
		// a clean document look dirty.
		return s.state(), nil
	}
	return s.announce(), nil
}

// Save writes the open document back to its own file.
//
// Returns ErrNoPath when the show has never been saved, which the caller
// turns into a Save As.
func (s *DocumentService) Save() (DocumentState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.path == "" {
		return s.state(), ErrNoPath
	}
	return s.saveTo(s.path)
}

// SaveAs writes the open document to a new file and adopts that path.
func (s *DocumentService) SaveAs(path string) (DocumentState, error) {
	clean := filepath.Clean(path)
	if err := validateFSPath(clean); err != nil {
		return s.State(), fmt.Errorf("invalid path: %w", err)
	}
	if !strings.EqualFold(filepath.Ext(clean), ".json") {
		clean += ".json"
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveTo(clean)
}

// Rename changes the show's own name, which is stored in the document and so
// counts as an edit.
func (s *DocumentService) Rename(name string) (DocumentState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.doc == nil {
		return s.state(), fmt.Errorf("no document")
	}
	s.doc.SetName(name)
	if err := s.adopt(s.doc, s.path, false); err != nil {
		return s.state(), err
	}
	return s.announce(), nil
}

// ErrNoPath means the document has never been written and needs a location.
var ErrNoPath = fmt.Errorf("this show has not been saved yet")

// saveTo writes the canonical bytes. Caller must hold the lock.
//
// The write goes to a sibling temporary file and is renamed into place, so an
// interrupted save cannot leave a truncated show where the good one was.
func (s *DocumentService) saveTo(path string) (DocumentState, error) {
	if s.canonical == nil {
		return s.state(), fmt.Errorf("no document to save")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return s.state(), fmt.Errorf("cannot create %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".constellation-save-*")
	if err != nil {
		return s.state(), fmt.Errorf("cannot write near %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	written := false
	defer func() {
		if !written {
			os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(s.canonical); err != nil {
		tmp.Close()
		return s.state(), fmt.Errorf("cannot write %s: %w", filepath.Base(path), err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return s.state(), fmt.Errorf("cannot flush %s: %w", filepath.Base(path), err)
	}
	if err := tmp.Close(); err != nil {
		return s.state(), fmt.Errorf("cannot close %s: %w", filepath.Base(path), err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return s.state(), fmt.Errorf("cannot replace %s: %w", filepath.Base(path), err)
	}
	written = true

	s.path = path
	s.savedHash = s.hash
	s.pushRecent(path)
	return s.announce(), nil
}

// --- recent documents ---------------------------------------------------

// Recent lists recently opened or saved shows, most recent first.
func (s *DocumentService) Recent() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.recent))
	copy(out, s.recent)
	return out
}

// pushRecent moves a path to the front of the list. Caller must hold the lock.
func (s *DocumentService) pushRecent(path string) {
	next := []string{path}
	for _, p := range s.recent {
		// Windows paths differ only by case for the same file, so a reopened
		// show would otherwise appear twice in the menu.
		if strings.EqualFold(p, path) {
			continue
		}
		next = append(next, p)
		if len(next) >= maxRecentDocuments {
			break
		}
	}
	s.recent = next
	saveRecentDocuments(s.recentPath, next)
}

// recentDocumentsPath is where the list persists between sessions. It is a
// preference about this machine, not part of any show, so it lives with the
// user's other application config rather than beside the project.
func recentDocumentsPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Constellation", "recent.json")
}

func loadRecentDocuments(path string) []string {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	// A file that has since been deleted or moved is worse than useless in a
	// reopen menu: it offers an action that can only fail.
	out := make([]string, 0, len(list))
	for _, p := range list {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			out = append(out, p)
		}
		if len(out) >= maxRecentDocuments {
			break
		}
	}
	return out
}

func saveRecentDocuments(path string, list []string) {
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	raw, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return
	}
	// Losing the recent list is a cosmetic failure; it must never interrupt
	// the save that triggered it.
	_ = os.WriteFile(path, raw, 0o644)
}
