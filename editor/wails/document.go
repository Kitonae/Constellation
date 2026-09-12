package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// DocumentVersion is the schema version this build writes into every document
// it saves. Parsing accepts anything at or below it; migrate brings an older
// or unversioned file up to it once, on load, so nothing downstream has to
// know about legacy shapes.
const DocumentVersion = 1

// Document is the editor's show file: the single contract shared by the Go
// shell, the React editor and the native renderer.
//
// The payload is kept as a decoded JSON tree rather than a struct graph on
// purpose. Round-tripping through typed fields would silently drop anything
// the structs do not name -- scene materials and meshes, camera and light
// nodes, per-clip effect maps -- and a save would then destroy parts of a
// show this build happens not to interpret. Typed views over the tree
// (Screens, Name) give Go what it actually needs to act on.
type Document struct {
	data map[string]any
}

// ScreenSpec is what the shell needs to know about one screen node: enough to
// launch, place and size an output for it. Everything else about the node is
// the editor's and the renderer's business.
type ScreenSpec struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	ScreenType string `json:"screenType"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Enabled    bool   `json:"enabled"`
	Positioned bool   `json:"positioned"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	Borderless bool   `json:"borderless"`
}

// ParseDocument decodes, validates and migrates a show file.
//
// The three steps are deliberately one call: every entry point that can
// introduce a document -- Open, a recent file, a command-line path -- must
// migrate it exactly once, and no caller should be able to skip validation by
// decoding the bytes itself.
func ParseDocument(raw []byte) (*Document, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	// Numbers stay as their source text, so a re-marshal writes back exactly
	// what was read instead of reformatting every value in the show through
	// float64.
	dec.UseNumber()

	var root any
	if err := dec.Decode(&root); err != nil {
		return nil, fmt.Errorf("not valid JSON: %w", err)
	}

	obj, ok := root.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("a show file must be a JSON object")
	}

	doc := &Document{data: obj}
	if err := doc.migrate(); err != nil {
		return nil, err
	}
	return doc, nil
}

// NewDocument is an empty show: one scene, no media, one empty track.
func NewDocument(name string) *Document {
	if name == "" {
		name = "Untitled"
	}
	return &Document{data: map[string]any{
		"version": json.Number(fmt.Sprint(DocumentVersion)),
		"project": map[string]any{
			"id":    "untitled",
			"name":  name,
			"scene": map[string]any{"id": "scene", "name": "Scene", "materials": []any{}, "meshes": []any{}, "roots": []any{}},
			"media": []any{},
			"timeline": map[string]any{
				"id":               "tl",
				"name":             "Timeline",
				"tracks":           []any{map[string]any{"media": []any{}}},
				"events":           []any{},
				"duration_seconds": json.Number("60"),
			},
		},
	}}
}

// Bytes is the canonical serialization: what gets written to disk, sent to
// renderers and handed to the editor. Indented because a show file is read
// and diffed by people.
func (d *Document) Bytes() ([]byte, error) {
	buf := &bytes.Buffer{}
	enc := json.NewEncoder(buf)
	enc.SetIndent("", "  ")
	// Show files carry Windows paths and clip names, not HTML; escaping
	// the angle brackets and ampersands turns readable URIs into noise.
	enc.SetEscapeHTML(false)
	if err := enc.Encode(d.data); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// Identity is the document's content, in a form that compares equal whenever
// two documents mean the same thing.
//
// Bytes preserves each number exactly as it was written, which is what a save
// should do. Comparison must not: the editor serializes through JavaScript,
// so a file holding "1e3" or "12.50" comes back as "1000" and "12.5" and a
// show would report unsaved changes the moment it was opened, before anyone
// touched it. Reducing every number to its value removes the distinction that
// does not matter while keeping the one that does.
func (d *Document) Identity() ([]byte, error) {
	return json.Marshal(normalizeNumbers(d.data))
}

// normalizeNumbers rewrites json.Number as float64 throughout a decoded tree.
func normalizeNumbers(v any) any {
	switch t := v.(type) {
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return f
		}
		return t.String()
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = normalizeNumbers(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalizeNumbers(val)
		}
		return out
	default:
		return v
	}
}

// Name is the show's display name, which is not the file name: Save As can
// write "cue-stack-v3.json" while the show inside is still called "Opening".
func (d *Document) Name() string {
	p, ok := asMap(d.data["project"])
	if !ok {
		return ""
	}
	s, _ := p["name"].(string)
	return s
}

// SetName renames the show itself.
func (d *Document) SetName(name string) {
	if p, ok := asMap(d.data["project"]); ok {
		p["name"] = name
	}
}

// Screens lists every screen node in the scene, depth first, in document
// order. This is the shell's view of what outputs a show wants.
func (d *Document) Screens() []ScreenSpec {
	out := []ScreenSpec{}
	p, ok := asMap(d.data["project"])
	if !ok {
		return out
	}
	scene, ok := asMap(p["scene"])
	if !ok {
		return out
	}
	roots, _ := asSlice(scene["roots"])

	var walk func(nodes []any)
	walk = func(nodes []any) {
		for _, raw := range nodes {
			n, ok := asMap(raw)
			if !ok {
				continue
			}
			if k, ok := asMap(n["kind"]); ok {
				if t, _ := k["type"].(string); t == "screen" {
					out = append(out, screenSpecOf(n, k))
				}
			}
			if kids, ok := asSlice(n["children"]); ok {
				walk(kids)
			}
		}
	}
	walk(roots)
	return out
}

func screenSpecOf(node, kind map[string]any) ScreenSpec {
	id, _ := node["id"].(string)
	name, _ := node["name"].(string)
	st, _ := kind["screenType"].(string)
	if st == "" {
		st = "web"
	}
	s := ScreenSpec{ID: id, Name: name, ScreenType: st, Enabled: true}
	if name == "" {
		s.Name = id
	}
	if px, ok := asSlice(kind["pixels"]); ok && len(px) >= 2 {
		s.Width = int(numOf(px[0], 0))
		s.Height = int(numOf(px[1], 0))
	}
	if e, ok := kind["enabled"].(bool); ok {
		s.Enabled = e
	}
	if o, ok := asMap(kind["output"]); ok {
		s.Positioned = true
		s.X = int(numOf(o["x"], 0))
		s.Y = int(numOf(o["y"], 0))
		s.Borderless, _ = o["borderless"].(bool)
	}
	return s
}

// --- validation and migration ------------------------------------------

// migrate brings any accepted document shape up to DocumentVersion.
//
// Every legacy shape the editor used to handle at read time lives here, so
// the store, the render list and the C++ parser can each assume one shape.
// Anything genuinely unreadable is an error rather than a silent repair: a
// show that loads as an empty timeline looks like data loss to an operator.
func (d *Document) migrate() error {
	// A file may be either the wrapper {"project": {...}} or a bare project.
	// The editor has always accepted both.
	if _, ok := d.data["project"]; !ok {
		if _, hasScene := d.data["scene"]; !hasScene {
			return fmt.Errorf("no project in this file: expected a \"project\" or \"scene\" key")
		}
		d.data = map[string]any{"project": d.data}
	}

	project, ok := asMap(d.data["project"])
	if !ok {
		return fmt.Errorf("%q must be an object", "project")
	}

	if _, ok := project["id"].(string); !ok {
		project["id"] = "untitled"
	}
	if _, ok := project["name"].(string); !ok {
		project["name"] = "Untitled"
	}

	if err := migrateScene(project); err != nil {
		return err
	}
	if err := migrateMedia(project); err != nil {
		return err
	}
	if err := migrateTimeline(project); err != nil {
		return err
	}

	d.data["version"] = json.Number(fmt.Sprint(DocumentVersion))
	return nil
}

func migrateScene(project map[string]any) error {
	raw, present := project["scene"]
	if !present || raw == nil {
		project["scene"] = map[string]any{"id": "scene", "name": "Scene", "materials": []any{}, "meshes": []any{}, "roots": []any{}}
		return nil
	}
	scene, ok := asMap(raw)
	if !ok {
		return fmt.Errorf("%q must be an object", "project.scene")
	}
	if _, ok := scene["id"].(string); !ok {
		scene["id"] = "scene"
	}
	if _, ok := scene["name"].(string); !ok {
		scene["name"] = "Scene"
	}
	ensureSlice(scene, "materials")
	ensureSlice(scene, "meshes")
	ensureSlice(scene, "roots")

	roots, _ := asSlice(scene["roots"])
	migrated, err := migrateNodes(roots)
	if err != nil {
		return err
	}
	scene["roots"] = migrated
	return nil
}

func migrateNodes(nodes []any) ([]any, error) {
	out := make([]any, 0, len(nodes))
	for _, raw := range nodes {
		n, ok := asMap(raw)
		if !ok {
			return nil, fmt.Errorf("every scene node must be an object")
		}
		if _, ok := n["id"].(string); !ok {
			return nil, fmt.Errorf("a scene node has no id")
		}
		ensureSlice(n, "children")
		kids, _ := asSlice(n["children"])
		migrated, err := migrateNodes(kids)
		if err != nil {
			return nil, err
		}
		n["children"] = migrated

		if k, ok := asMap(n["kind"]); ok {
			if t, _ := k["type"].(string); t == "screen" {
				migrateScreenKind(k)
			}
		}
		out = append(out, n)
	}
	return out, nil
}

// migrateScreenKind fills in the three fields every consumer reads without
// checking: a screen with no pixels sized its output 0x0, and a missing
// screenType meant "web" in one place and "unknown" in another.
func migrateScreenKind(kind map[string]any) {
	if st, _ := kind["screenType"].(string); st == "" {
		kind["screenType"] = "web"
	}
	px, ok := asSlice(kind["pixels"])
	if !ok || len(px) < 2 {
		kind["pixels"] = []any{json.Number("1920"), json.Number("1080")}
	} else {
		kind["pixels"] = []any{
			json.Number(fmt.Sprint(int(numOf(px[0], 1920)))),
			json.Number(fmt.Sprint(int(numOf(px[1], 1080)))),
		}
	}
	if _, ok := kind["enabled"].(bool); !ok {
		kind["enabled"] = true
	}
}

func migrateMedia(project map[string]any) error {
	raw, present := project["media"]
	if !present || raw == nil {
		project["media"] = []any{}
		return nil
	}
	list, ok := asSlice(raw)
	if !ok {
		return fmt.Errorf("%q must be an array", "project.media")
	}
	for _, item := range list {
		m, ok := asMap(item)
		if !ok {
			return fmt.Errorf("every media asset must be an object")
		}
		if _, ok := m["id"].(string); !ok {
			return fmt.Errorf("a media asset has no id")
		}
		if _, ok := m["duration_seconds"]; !ok {
			m["duration_seconds"] = json.Number("10")
		}
	}
	return nil
}

func migrateTimeline(project map[string]any) error {
	raw, present := project["timeline"]
	if !present || raw == nil {
		project["timeline"] = map[string]any{
			"id": "tl", "name": "Timeline",
			"tracks": []any{map[string]any{"media": []any{}}},
			"events": []any{}, "duration_seconds": json.Number("60"),
		}
		return nil
	}
	tl, ok := asMap(raw)
	if !ok {
		return fmt.Errorf("%q must be an object", "project.timeline")
	}
	if _, ok := tl["id"].(string); !ok {
		tl["id"] = "tl"
	}
	if _, ok := tl["name"].(string); !ok {
		tl["name"] = "Timeline"
	}
	ensureSlice(tl, "events")
	if _, ok := tl["duration_seconds"]; !ok {
		tl["duration_seconds"] = json.Number("60")
	}

	tracksRaw, present := tl["tracks"]
	if !present || tracksRaw == nil {
		tl["tracks"] = []any{map[string]any{"media": []any{}}}
		return nil
	}
	tracks, ok := asSlice(tracksRaw)
	if !ok {
		return fmt.Errorf("%q must be an array", "project.timeline.tracks")
	}
	for _, item := range tracks {
		t, ok := asMap(item)
		if !ok {
			return fmt.Errorf("every timeline track must be an object")
		}
		if err := migrateTrackClips(t); err != nil {
			return err
		}
	}
	return nil
}

// migrateTrackClips normalises one track's clip list.
//
// The oldest files hold a single clip object where later ones hold an array,
// which the store used to repair on every load. Doing it here means the
// store, the web render list and the C++ parser all see an array.
func migrateTrackClips(track map[string]any) error {
	raw, present := track["media"]
	switch {
	case !present || raw == nil:
		track["media"] = []any{}
		return nil
	case isMap(raw):
		track["media"] = []any{raw}
	}

	clips, ok := asSlice(track["media"])
	if !ok {
		return fmt.Errorf("a track's %q must be an array or a single clip", "media")
	}
	for _, item := range clips {
		c, ok := asMap(item)
		if !ok {
			return fmt.Errorf("every timeline clip must be an object")
		}
		if _, ok := c["id"].(string); !ok {
			return fmt.Errorf("a timeline clip has no id")
		}
		if _, ok := c["start"]; !ok {
			c["start"] = json.Number("0")
		}
		if _, ok := c["duration"]; !ok {
			c["duration"] = json.Number("0")
		}
		// The source in-point is the field the native renderer used to lack
		// entirely, so a split video restarted at every cut. Defaulting it
		// here means neither renderer has to guess.
		if _, ok := c["in_seconds"]; !ok {
			c["in_seconds"] = json.Number("0")
		}
	}
	return nil
}

// --- small helpers over the decoded tree --------------------------------

func asMap(v any) (map[string]any, bool) {
	m, ok := v.(map[string]any)
	return m, ok
}

func isMap(v any) bool {
	_, ok := v.(map[string]any)
	return ok
}

func asSlice(v any) ([]any, bool) {
	s, ok := v.([]any)
	return s, ok
}

func ensureSlice(m map[string]any, key string) {
	if _, ok := asSlice(m[key]); !ok {
		m[key] = []any{}
	}
}

// numOf reads a number that UseNumber left as its source text.
func numOf(v any, def float64) float64 {
	switch n := v.(type) {
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return f
		}
	case float64:
		return n
	}
	return def
}
