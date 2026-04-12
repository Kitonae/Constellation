import { loadProjectDocument } from '../project/projectCodec.js'

export function parseProject(json) {
  return loadProjectDocument(json)
}
