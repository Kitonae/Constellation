/**
 * Serializes the in-memory editor state back into the on-disk / on-the-wire
 * project wrapper (the same shape as examples/scene.example.json).
 *
 * Kept in one place so the shell (which saves it and sends it to the
 * renderers), the web output windows and the round-trip test all agree on
 * the schema.
 */
export function buildProjectWrapper(project, scene) {
  if (!project || !scene) { throw new Error('No project loaded') }
  return {
    project: {
      // Anything this build has no opinion about is carried through, for the
      // same reason parseProject preserves it: what comes out of here is what
      // gets written to the file. Naming only the fields the editor uses
      // meant a save quietly dropped the rest.
      ...project,
      id: project.id,
      name: project.name,
      scene: scene,
      media: project.media ?? [],
      timeline: project.timeline ?? { id: 'tl', name: 'Timeline', tracks: [], events: [], duration_seconds: 60 },
    }
  }
}
