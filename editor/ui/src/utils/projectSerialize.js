/**
 * Serializes the in-memory editor state back into the on-disk / on-the-wire
 * project wrapper (the same shape as examples/scene.example.json).
 *
 * Kept in one place so App (Save Show), the native sink (PushSnapshot) and the
 * round-trip test all agree on the schema.
 */
export function buildProjectWrapper(project, scene) {
  if (!project || !scene) { throw new Error('No project loaded') }
  return {
    project: {
      id: project.id,
      name: project.name,
      scene: scene,
      media: project.media ?? [],
      timeline: project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: 60 },
    }
  }
}
