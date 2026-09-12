package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// mustParse fails the test rather than returning an error, so the assertions
// in each case stay about the document rather than about error handling.
func mustParse(t *testing.T, raw string) *Document {
	t.Helper()
	doc, err := ParseDocument([]byte(raw))
	if err != nil {
		t.Fatalf("ParseDocument: %v", err)
	}
	return doc
}

// reparse round-trips a document through its canonical bytes and returns the
// decoded tree, which is how every consumer actually receives it.
func reparse(t *testing.T, doc *Document) map[string]any {
	t.Helper()
	raw, err := doc.Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("canonical bytes are not valid JSON: %v\n%s", err, raw)
	}
	return out
}

func TestParseDocument_KeepsFieldsGoDoesNotInterpret(t *testing.T) {
	// The shell has no opinion about materials, meshes, cameras or per-clip
	// effect maps. Saving a show must not be how an operator discovers that:
	// a typed round-trip would drop every one of these.
	src := `{
      "project": {
        "id": "p1", "name": "Show",
        "scene": {
          "id": "s", "name": "Scene",
          "materials": [{"id": "m1", "albedo": [1, 0.5, 0]}],
          "meshes": [{"id": "mesh1", "verts": 24}],
          "roots": [
            {"id": "cam", "name": "Camera", "children": [],
             "kind": {"type": "camera", "cam": {"fov": 55.5}}},
            {"id": "scr", "name": "Front", "children": [],
             "kind": {"type": "screen", "screenType": "renderer", "pixels": [3840, 2160], "enabled": true}}
          ]
        },
        "media": [{"id": "a1", "name": "clip.mp4", "uri": "file:///C:/m/clip.mp4", "duration_seconds": 12.5}],
        "timeline": {
          "id": "tl", "name": "Timeline", "events": [], "duration_seconds": 60,
          "tracks": [{"media": [
            {"id": "t1", "clipId": "a1", "start": 0, "duration": 5, "in_seconds": 2,
             "effects": {"saturation": {"enabled": true, "value": 1.4}}}
          ]}]
        }
      }
    }`

	got := reparse(t, mustParse(t, src))
	project := got["project"].(map[string]any)
	scene := project["scene"].(map[string]any)

	if mats := scene["materials"].([]any); len(mats) != 1 {
		t.Errorf("materials lost: %v", scene["materials"])
	}
	if meshes := scene["meshes"].([]any); len(meshes) != 1 {
		t.Errorf("meshes lost: %v", scene["meshes"])
	}
	cam := scene["roots"].([]any)[0].(map[string]any)["kind"].(map[string]any)
	if cam["type"] != "camera" {
		t.Errorf("camera node lost, got %v", cam)
	}
	if fov := cam["cam"].(map[string]any)["fov"]; fov != 55.5 {
		t.Errorf("camera fov lost, got %v", fov)
	}
	clip := project["timeline"].(map[string]any)["tracks"].([]any)[0].(map[string]any)["media"].([]any)[0].(map[string]any)
	effects, ok := clip["effects"].(map[string]any)
	if !ok {
		t.Fatalf("per-clip effects lost: %v", clip)
	}
	if sat := effects["saturation"].(map[string]any)["value"]; sat != 1.4 {
		t.Errorf("effect value lost, got %v", sat)
	}
}

func TestParseDocument_NumbersKeepTheirExactText(t *testing.T) {
	// Decoding through float64 and re-encoding rewrites every number in the
	// show. A position of 1920.0000000000002 is not a difference an operator
	// made, and it would make the file dirty the moment it was opened.
	src := `{"project":{"id":"p","name":"n","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[
	    {"id":"c","clipId":"a","start":0.30000000000000004,"duration":1e3,"in_seconds":0}
	  ]}]}}}`
	raw, err := mustParse(t, src).Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	text := string(raw)
	if !strings.Contains(text, "0.30000000000000004") {
		t.Errorf("start was reformatted:\n%s", text)
	}
	if !strings.Contains(text, "1e3") {
		t.Errorf("duration was reformatted:\n%s", text)
	}
}

func TestParseDocument_MigratesSingleClipTrackToArray(t *testing.T) {
	// The oldest show files hold one clip object where later ones hold an
	// array. The store repaired this on load; doing it here means the web
	// render list and the C++ parser see one shape too.
	src := `{"project":{"id":"p","name":"n","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":{"id":"c","clipId":"a","start":1,"duration":2}}]}}}`

	got := reparse(t, mustParse(t, src))
	tracks := got["project"].(map[string]any)["timeline"].(map[string]any)["tracks"].([]any)
	clips, ok := tracks[0].(map[string]any)["media"].([]any)
	if !ok {
		t.Fatalf("track media is not an array: %T", tracks[0].(map[string]any)["media"])
	}
	if len(clips) != 1 || clips[0].(map[string]any)["id"] != "c" {
		t.Errorf("clip lost in migration: %v", clips)
	}
}

func TestParseDocument_DefaultsSourceInPoint(t *testing.T) {
	// A clip with no in_seconds is a clip that starts at the head of its
	// source. Leaving the field absent is what let the native renderer and
	// the web preview disagree about where a split video resumes.
	src := `{"project":{"id":"p","name":"n","scene":{"id":"s","name":"S","roots":[]},
	  "media":[],"timeline":{"tracks":[{"media":[{"id":"c","clipId":"a","start":0,"duration":2}]}]}}}`

	got := reparse(t, mustParse(t, src))
	clip := got["project"].(map[string]any)["timeline"].(map[string]any)["tracks"].([]any)[0].(map[string]any)["media"].([]any)[0].(map[string]any)
	if in, ok := clip["in_seconds"]; !ok || in != float64(0) {
		t.Errorf("in_seconds not defaulted, got %v", clip["in_seconds"])
	}
}

func TestParseDocument_AcceptsBareProject(t *testing.T) {
	src := `{"id":"p","name":"Bare","scene":{"id":"s","name":"S","roots":[]},"media":[],"timeline":{"tracks":[]}}`
	doc := mustParse(t, src)
	if doc.Name() != "Bare" {
		t.Errorf("expected the bare project to be wrapped, name = %q", doc.Name())
	}
	got := reparse(t, doc)
	if _, ok := got["project"]; !ok {
		t.Errorf("bare project was not wrapped: %v", got)
	}
}

func TestParseDocument_FillsMissingSections(t *testing.T) {
	doc := mustParse(t, `{"project":{"scene":{"roots":[]}}}`)
	got := reparse(t, doc)
	project := got["project"].(map[string]any)

	if _, ok := project["media"].([]any); !ok {
		t.Errorf("media not defaulted to an array: %v", project["media"])
	}
	tl, ok := project["timeline"].(map[string]any)
	if !ok {
		t.Fatalf("timeline not defaulted: %v", project["timeline"])
	}
	tracks, ok := tl["tracks"].([]any)
	if !ok || len(tracks) != 1 {
		t.Fatalf("expected one empty track, got %v", tl["tracks"])
	}
	if clips := tracks[0].(map[string]any)["media"].([]any); len(clips) != 0 {
		t.Errorf("expected the default track to be empty, got %v", clips)
	}
	scene := project["scene"].(map[string]any)
	for _, key := range []string{"materials", "meshes", "roots"} {
		if _, ok := scene[key].([]any); !ok {
			t.Errorf("scene.%s not defaulted to an array: %v", key, scene[key])
		}
	}
}

func TestParseDocument_StampsVersion(t *testing.T) {
	got := reparse(t, mustParse(t, `{"project":{"scene":{"roots":[]}}}`))
	if v, ok := got["version"].(float64); !ok || int(v) != DocumentVersion {
		t.Errorf("expected version %d, got %v", DocumentVersion, got["version"])
	}
}

func TestParseDocument_NormalisesScreenKind(t *testing.T) {
	// Each of these used to be read without a check somewhere: a screen with
	// no pixels sized its output zero by zero, and a missing screenType meant
	// "web" in one consumer and "unknown" in another.
	src := `{"project":{"scene":{"roots":[
	  {"id":"a","name":"A","kind":{"type":"screen"}},
	  {"id":"b","name":"B","kind":{"type":"screen","pixels":[1280.7,720.2],"screenType":"renderer","enabled":false}}
	]}}}`

	doc := mustParse(t, src)
	screens := doc.Screens()
	if len(screens) != 2 {
		t.Fatalf("expected 2 screens, got %d", len(screens))
	}
	if screens[0].ScreenType != "web" || screens[0].Width != 1920 || screens[0].Height != 1080 || !screens[0].Enabled {
		t.Errorf("defaults not applied: %+v", screens[0])
	}
	if screens[1].Width != 1280 || screens[1].Height != 720 {
		t.Errorf("fractional pixels not rounded to whole ones: %+v", screens[1])
	}
	if screens[1].Enabled {
		t.Errorf("explicit enabled=false was overwritten: %+v", screens[1])
	}
}

func TestDocumentScreens_FindsNestedAndPlaced(t *testing.T) {
	src := `{"project":{"scene":{"roots":[
	  {"id":"group","name":"Group","kind":{"type":"mesh","mesh":{}},"children":[
	    {"id":"deep","name":"Deep","kind":{"type":"screen","screenType":"renderer","pixels":[1920,1080],
	      "output":{"x":-1920,"y":120,"borderless":true}}}
	  ]}
	]}}}`

	screens := mustParse(t, src).Screens()
	if len(screens) != 1 {
		t.Fatalf("expected the nested screen to be found, got %d", len(screens))
	}
	s := screens[0]
	if !s.Positioned || s.X != -1920 || s.Y != 120 || !s.Borderless {
		t.Errorf("placement not read: %+v", s)
	}
}

func TestDocumentScreens_NoScreensIsEmptyNotNil(t *testing.T) {
	// The frontend iterates this without a null check.
	if got := mustParse(t, `{"project":{"scene":{"roots":[]}}}`).Screens(); got == nil {
		t.Error("Screens returned nil rather than an empty slice")
	}
}

func TestParseDocument_Rejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"not JSON", `{ nope`},
		{"not an object", `[1,2,3]`},
		{"no project or scene", `{"hello":"world"}`},
		{"project is not an object", `{"project":"nope"}`},
		{"scene is not an object", `{"project":{"scene":42}}`},
		{"tracks is not an array", `{"project":{"scene":{"roots":[]},"timeline":{"tracks":"nope"}}}`},
		{"clip has no id", `{"project":{"scene":{"roots":[]},"timeline":{"tracks":[{"media":[{"clipId":"a"}]}]}}}`},
		{"node has no id", `{"project":{"scene":{"roots":[{"name":"nameless"}]}}}`},
		{"media asset has no id", `{"project":{"scene":{"roots":[]},"media":[{"name":"x"}]}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseDocument([]byte(tc.raw)); err == nil {
				t.Errorf("expected %s to be rejected", tc.name)
			}
		})
	}
}

func TestNewDocument_IsValidAndEmpty(t *testing.T) {
	raw, err := NewDocument("Opening").Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	// The document the application starts on must survive its own parser,
	// or the first edit would be rejected as invalid.
	doc, err := ParseDocument(raw)
	if err != nil {
		t.Fatalf("a new document does not parse: %v", err)
	}
	if doc.Name() != "Opening" {
		t.Errorf("name = %q, want Opening", doc.Name())
	}
	if len(doc.Screens()) != 0 {
		t.Errorf("a new show should have no screens, got %d", len(doc.Screens()))
	}
}

func TestParseDocument_IsIdempotent(t *testing.T) {
	// Update re-parses the editor's own output on every edit. If migration
	// were not a fixed point, the document would drift and every save would
	// differ from the last for no reason.
	src := `{"project":{"scene":{"roots":[{"id":"a","name":"A","kind":{"type":"screen"}}]},
	  "timeline":{"tracks":[{"media":{"id":"c","clipId":"x"}}]}}}`

	once, err := mustParse(t, src).Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	twice, err := mustParse(t, string(once)).Bytes()
	if err != nil {
		t.Fatalf("Bytes: %v", err)
	}
	if string(once) != string(twice) {
		t.Errorf("migration is not a fixed point:\nfirst:\n%s\nsecond:\n%s", once, twice)
	}
}

func TestDocumentSetName(t *testing.T) {
	doc := mustParse(t, `{"project":{"name":"Old","scene":{"roots":[]}}}`)
	doc.SetName("New")
	if doc.Name() != "New" {
		t.Errorf("name = %q, want New", doc.Name())
	}
	got := reparse(t, doc)
	if n := got["project"].(map[string]any)["name"]; n != "New" {
		t.Errorf("rename did not reach the canonical bytes, got %v", n)
	}
}
