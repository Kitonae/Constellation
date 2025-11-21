package main

import (
	"encoding/json"
	"fmt"

	pb "github.com/kitonae/constellation/editor/internal/proto/proto/constellation/v1"
)

// JSON structures matching the editor's JSON format
type Vec3J struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	Z float32 `json:"z"`
}

type QuatJ struct {
	X float32 `json:"x"`
	Y float32 `json:"y"`
	Z float32 `json:"z"`
	W float32 `json:"w"`
}

type TransformJ struct {
	Position Vec3J `json:"position"`
	Rotation QuatJ `json:"rotation"`
	Scale    Vec3J `json:"scale"`
}

type ColorJ struct {
	R float32 `json:"r"`
	G float32 `json:"g"`
	B float32 `json:"b"`
	A float32 `json:"a"`
}

type MaterialPbrJ struct {
	ID        string   `json:"id"`
	Name      *string  `json:"name,omitempty"`
	BaseColor *ColorJ  `json:"base_color,omitempty"`
	Metallic  *float32 `json:"metallic,omitempty"`
	Roughness *float32 `json:"roughness,omitempty"`
	Emissive  *ColorJ  `json:"emissive,omitempty"`
}

type MeshRefJ struct {
	ID   string  `json:"id"`
	URI  string  `json:"uri"`
	Node *string `json:"node,omitempty"`
}

type MeshCompJ struct {
	Mesh       MeshRefJ `json:"mesh"`
	MaterialID *string  `json:"material_id,omitempty"`
}

type LightCompJ struct {
	Type      string   `json:"type"`
	Color     ColorJ   `json:"color"`
	Intensity float32  `json:"intensity"`
	Range     float32  `json:"range"`
	SpotAngle *float32 `json:"spot_angle,omitempty"`
}

type ScreenCompJ struct {
	PixelsX int32 `json:"pixels_x"`
	PixelsY int32 `json:"pixels_y"`
}

type CameraCompJ struct {
	FovDeg float32 `json:"fov_deg"`
	Near   float32 `json:"near"`
	Far    float32 `json:"far"`
}

type NodeJ struct {
	ID        string       `json:"id"`
	Name      *string      `json:"name,omitempty"`
	Transform TransformJ   `json:"transform"`
	Children  []NodeJ      `json:"children,omitempty"`
	Mesh      *MeshCompJ   `json:"mesh,omitempty"`
	Light     *LightCompJ  `json:"light,omitempty"`
	Screen    *ScreenCompJ `json:"screen,omitempty"`
	Camera    *CameraCompJ `json:"camera,omitempty"`
}

type SceneJ struct {
	ID        string         `json:"id"`
	Name      *string        `json:"name,omitempty"`
	Materials []MaterialPbrJ `json:"materials,omitempty"`
	Meshes    []MeshRefJ     `json:"meshes,omitempty"`
	Roots     []NodeJ        `json:"roots,omitempty"`
}

type MediaClipJ struct {
	ID              string  `json:"id"`
	Name            *string `json:"name,omitempty"`
	URI             string  `json:"uri"`
	DurationSeconds float64 `json:"duration_seconds"`
}

type TrackMediaJ struct {
	TargetNodeID   string  `json:"target_node_id"`
	ClipID         string  `json:"clip_id"`
	InSeconds      float64 `json:"in_seconds"`
	OutSeconds     float64 `json:"out_seconds"`
	StartAtSeconds float64 `json:"start_at_seconds"`
}

type TimelineTrackJ struct {
	Media *TrackMediaJ `json:"media,omitempty"`
}

type TimelineEventJ struct {
	T      float64           `json:"t"`
	Action string            `json:"action"`
	Params map[string]string `json:"params,omitempty"`
}

type TimelineJ struct {
	ID              string           `json:"id"`
	Name            *string          `json:"name,omitempty"`
	Tracks          []TimelineTrackJ `json:"tracks,omitempty"`
	Events          []TimelineEventJ `json:"events,omitempty"`
	DurationSeconds float64          `json:"duration_seconds"`
}

type ProjectJ struct {
	ID       string       `json:"id"`
	Name     *string      `json:"name,omitempty"`
	Scene    SceneJ       `json:"scene"`
	Media    []MediaClipJ `json:"media,omitempty"`
	Timeline TimelineJ    `json:"timeline"`
}

type ProjectWrapperJ struct {
	Project ProjectJ `json:"project"`
}

// Conversion functions
func v3(v Vec3J) *pb.Vec3 {
	return &pb.Vec3{X: v.X, Y: v.Y, Z: v.Z}
}

func q(quat QuatJ) *pb.Quat {
	return &pb.Quat{X: quat.X, Y: quat.Y, Z: quat.Z, W: quat.W}
}

func transform(t TransformJ) *pb.Transform {
	return &pb.Transform{
		Position: v3(t.Position),
		Rotation: q(t.Rotation),
		Scale:    v3(t.Scale),
	}
}

func color(c ColorJ) *pb.ColorRGBA {
	return &pb.ColorRGBA{R: c.R, G: c.G, B: c.B, A: c.A}
}

func material(m MaterialPbrJ) *pb.MaterialPBR {
	mat := &pb.MaterialPBR{
		Id:   m.ID,
		Name: "",
	}
	if m.Name != nil {
		mat.Name = *m.Name
	}
	if m.BaseColor != nil {
		mat.BaseColor = color(*m.BaseColor)
	}
	if m.Metallic != nil {
		mat.Metallic = *m.Metallic
	} else {
		mat.Metallic = 0.0
	}
	if m.Roughness != nil {
		mat.Roughness = *m.Roughness
	} else {
		mat.Roughness = 1.0
	}
	if m.Emissive != nil {
		mat.Emissive = color(*m.Emissive)
	}
	return mat
}

func meshRef(m MeshRefJ) *pb.MeshRef {
	mesh := &pb.MeshRef{
		Id:  m.ID,
		Uri: m.URI,
	}
	if m.Node != nil {
		mesh.Node = *m.Node
	}
	return mesh
}

func node(n NodeJ) *pb.Node {
	result := &pb.Node{
		Id:        n.ID,
		Name:      "",
		Transform: transform(n.Transform),
		Children:  make([]*pb.Node, 0, len(n.Children)),
	}
	if n.Name != nil {
		result.Name = *n.Name
	}

	for _, child := range n.Children {
		result.Children = append(result.Children, node(child))
	}

	// Set component (only one can be set)
	if n.Screen != nil {
		result.Comp0 = &pb.Node_Screen{
			Screen: &pb.ScreenComponent{
				PixelsX: n.Screen.PixelsX,
				PixelsY: n.Screen.PixelsY,
			},
		}
	} else if n.Light != nil {
		lightType := pb.LightComponent_POINT
		switch n.Light.Type {
		case "DIRECTIONAL":
			lightType = pb.LightComponent_DIRECTIONAL
		case "SPOT":
			lightType = pb.LightComponent_SPOT
		}
		spotAngle := float32(0.0)
		if n.Light.SpotAngle != nil {
			spotAngle = *n.Light.SpotAngle
		}
		result.Comp0 = &pb.Node_Light{
			Light: &pb.LightComponent{
				Type:      lightType,
				Color:     color(n.Light.Color),
				Intensity: n.Light.Intensity,
				Range:     n.Light.Range,
				SpotAngle: spotAngle,
			},
		}
	} else if n.Camera != nil {
		result.Comp0 = &pb.Node_Camera{
			Camera: &pb.CameraComponent{
				FovDeg: n.Camera.FovDeg,
				Near:   n.Camera.Near,
				Far:    n.Camera.Far,
			},
		}
	} else if n.Mesh != nil {
		materialID := ""
		if n.Mesh.MaterialID != nil {
			materialID = *n.Mesh.MaterialID
		}
		result.Comp0 = &pb.Node_Mesh{
			Mesh: &pb.MeshComponent{
				Mesh:       meshRef(n.Mesh.Mesh),
				MaterialId: materialID,
			},
		}
	}

	return result
}

func scene(s SceneJ) *pb.Scene {
	scene := &pb.Scene{
		Id:        s.ID,
		Name:      "",
		Materials: make([]*pb.MaterialPBR, 0, len(s.Materials)),
		Meshes:    make([]*pb.MeshRef, 0, len(s.Meshes)),
		Roots:     make([]*pb.Node, 0, len(s.Roots)),
	}
	if s.Name != nil {
		scene.Name = *s.Name
	}

	for _, mat := range s.Materials {
		scene.Materials = append(scene.Materials, material(mat))
	}
	for _, mesh := range s.Meshes {
		scene.Meshes = append(scene.Meshes, meshRef(mesh))
	}
	for _, root := range s.Roots {
		scene.Roots = append(scene.Roots, node(root))
	}

	return scene
}

// JSONToProject converts editor JSON to protobuf Project
func JSONToProject(jsonStr string) (*pb.Project, error) {
	var wrapper ProjectWrapperJ
	if err := json.Unmarshal([]byte(jsonStr), &wrapper); err != nil {
		return nil, fmt.Errorf("failed to parse JSON: %w", err)
	}

	p := wrapper.Project

	// Convert media clips
	media := make([]*pb.MediaClip, 0, len(p.Media))
	for _, m := range p.Media {
		clip := &pb.MediaClip{
			Id:              m.ID,
			Name:            "",
			Uri:             m.URI,
			DurationSeconds: m.DurationSeconds,
		}
		if m.Name != nil {
			clip.Name = *m.Name
		}
		media = append(media, clip)
	}

	// Convert timeline tracks
	tracks := make([]*pb.TimelineTrack, 0, len(p.Timeline.Tracks))
	for _, t := range p.Timeline.Tracks {
		if t.Media != nil {
			tracks = append(tracks, &pb.TimelineTrack{
				Kind: &pb.TimelineTrack_Media{
					Media: &pb.TrackMedia{
						TargetNodeId:   t.Media.TargetNodeID,
						ClipId:         t.Media.ClipID,
						InSeconds:      t.Media.InSeconds,
						OutSeconds:     t.Media.OutSeconds,
						StartAtSeconds: t.Media.StartAtSeconds,
					},
				},
			})
		}
	}

	// Convert timeline events
	events := make([]*pb.TimelineEvent, 0, len(p.Timeline.Events))
	for _, e := range p.Timeline.Events {
		events = append(events, &pb.TimelineEvent{
			T:      e.T,
			Action: e.Action,
			Params: e.Params,
		})
	}

	// Build timeline
	timelineName := ""
	if p.Timeline.Name != nil {
		timelineName = *p.Timeline.Name
	}
	timeline := &pb.Timeline{
		Id:              p.Timeline.ID,
		Name:            timelineName,
		Tracks:          tracks,
		Events:          events,
		DurationSeconds: p.Timeline.DurationSeconds,
	}

	// Build project
	projectName := ""
	if p.Name != nil {
		projectName = *p.Name
	}
	project := &pb.Project{
		Id:       p.ID,
		Name:     projectName,
		Scene:    scene(p.Scene),
		Media:    media,
		Timeline: timeline,
	}

	return project, nil
}
