package main

import (
	"errors"
	"log"
	"path/filepath"
)

// Document bindings.
//
// The editor performs the edits; the shell decides what a document is, where
// it lives and whether it has unsaved work. Save used to be a browser
// download of a blob, so the application never learned a path: there was no
// Save that overwrote, no recent files, and the dirty flag compared two
// object references in a React store.

// GetDocumentState reports the open show. The editor calls this once at
// startup and then follows the document:state event.
func (a *App) GetDocumentState() DocumentState {
	return a.docs.State()
}

// GetDocumentContents returns the canonical JSON of the open show, already
// validated and migrated.
func (a *App) GetDocumentContents() string {
	return a.docs.Contents()
}

// NewShow replaces the open document with an empty one.
//
// The caller is responsible for asking about unsaved work first: only the UI
// can put that question to the operator, and only it knows whether the answer
// was cancel.
func (a *App) NewShow() (OpenedDocument, error) {
	res, err := a.docs.New()
	if err != nil {
		return res, err
	}
	a.adoptDocument(res.Contents)
	return res, nil
}

// OpenShow asks for a file and loads it.
func (a *App) OpenShow() (OpenedDocument, error) {
	if a.app == nil {
		return OpenedDocument{}, errors.New("no application window")
	}
	path, err := a.app.Dialog.OpenFile().
		SetTitle("Open Show").
		CanChooseFiles(true).
		AddFilter("Constellation Show", "*.json").
		AddFilter("All Files", "*.*").
		PromptForSingleSelection()
	if err != nil {
		return OpenedDocument{}, err
	}
	if path == "" {
		return OpenedDocument{Cancelled: true, State: a.docs.State()}, nil
	}
	return a.OpenShowPath(path)
}

// OpenShowPath loads a specific file, for the recent-files menu and for a
// path handed to the application on its command line.
func (a *App) OpenShowPath(path string) (OpenedDocument, error) {
	res, err := a.docs.Open(path)
	if err != nil {
		return OpenedDocument{State: a.docs.State()}, err
	}
	a.adoptDocument(res.Contents)
	log.Printf("Opened show %s", path)
	return res, nil
}

// SaveShow writes the open show back to its own file, falling through to
// Save As when it has never been saved.
func (a *App) SaveShow() (SavedDocument, error) {
	st, err := a.docs.Save()
	if errors.Is(err, ErrNoPath) {
		return a.SaveShowAs()
	}
	if err != nil {
		return SavedDocument{State: st}, err
	}
	return SavedDocument{State: st}, nil
}

// SaveShowAs asks for a location and writes the open show there.
func (a *App) SaveShowAs() (SavedDocument, error) {
	if a.app == nil {
		return SavedDocument{}, errors.New("no application window")
	}
	current := a.docs.State()
	suggested := current.FileName
	if suggested == "" {
		suggested = sanitizeFileName(current.Name) + ".json"
	}
	dialog := a.app.Dialog.SaveFile().
		SetMessage("Save Show").
		SetFilename(suggested).
		AddFilter("Constellation Show", "*.json").
		CanCreateDirectories(true)
	if current.Path != "" {
		dialog = dialog.SetDirectory(filepath.Dir(current.Path))
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return SavedDocument{State: current}, err
	}
	if path == "" {
		return SavedDocument{State: current, Cancelled: true}, nil
	}
	st, err := a.docs.SaveAs(path)
	if err != nil {
		return SavedDocument{State: st}, err
	}
	log.Printf("Saved show to %s", st.Path)
	return SavedDocument{State: st}, nil
}

// UpdateShow records an edited document and forwards it to every renderer.
//
// One call for what used to be two independent paths: a PushSnapshot that
// fed the outputs and a React reference comparison that decided the title bar
// dot. They could disagree, and after an undo they did.
func (a *App) UpdateShow(contents string) (DocumentState, error) {
	st, err := a.docs.Update([]byte(contents))
	if err != nil {
		return st, err
	}
	a.hub.BroadcastSnapshot([]byte(a.docs.Contents()))
	return st, nil
}

// RenameShow changes the show's own name, independently of its file name.
func (a *App) RenameShow(name string) (DocumentState, error) {
	st, err := a.docs.Rename(name)
	if err != nil {
		return st, err
	}
	a.hub.BroadcastSnapshot([]byte(a.docs.Contents()))
	return st, nil
}

// GetRecentShows lists recently opened or saved shows, most recent first.
func (a *App) GetRecentShows() []string {
	return a.docs.Recent()
}

// adoptDocument is the common tail of New and Open: the show on stage must
// change at the same moment the show in the editor does, and neither may
// inherit the previous one's playhead.
func (a *App) adoptDocument(contents string) {
	if a.transport != nil {
		a.transport.Reset()
	}
	if a.hub != nil {
		a.hub.BroadcastSnapshot([]byte(contents))
	}
}

// sanitizeFileName turns a show name into something Windows will accept as a
// file name, so a show called "Act 1: Opening" can be offered as a default.
func sanitizeFileName(name string) string {
	if name == "" {
		return "show"
	}
	out := make([]rune, 0, len(name))
	for _, r := range name {
		switch r {
		case '<', '>', ':', '"', '/', '\\', '|', '?', '*':
			out = append(out, '-')
		default:
			if r < 0x20 {
				continue
			}
			out = append(out, r)
		}
	}
	trimmed := trimDotsAndSpaces(string(out))
	if trimmed == "" {
		return "show"
	}
	return trimmed
}

func trimDotsAndSpaces(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '.') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '.') {
		end--
	}
	return s[start:end]
}
