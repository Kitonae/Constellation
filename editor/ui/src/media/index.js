// Media Foundation — barrel export
//
// This module provides the complete media foundation layer for Constellation,
// modeled after Microsoft Media Foundation's architecture:
//
//   Primitives:  uri.js, asset.js
//   Pipeline:    timeline.js, renderer.js
//   Control:     clock.js, session.js
//
// Usage:
//   import { resolveUri, createAsset, computeRenderList, ... } from '../media/index.js'

// --- Primitives ---

export {
  setFileServerBase,
  getFileServerBase,
  toFileUri,
  fromFileUri,
  resolveUri,
  resolveUriSync,
} from './uri.js'

export {
  extFromUri,
  mediaTypeFromExt,
  isMediaFile,
  isImage,
  isVideo,
  isAudio,
  isColor,
  isText,
  createAsset,
  probeAsset,
  migrateAsset,
  getAssetDuration,
  createPresentationDescriptor,
  selectStream,
  getSelectedStreams,
} from './asset.js'

// --- Pipeline ---

export {
  createTimelineClip,
  createTrack,
  createTimeline,
  getActiveClips,
  getClipSourceTime,
  getClipOpacity,
  getClipFilterString,
  computeTimelineDuration,
  migrateTimelineItem,
  migrateTrack,
  migrateTimeline,
  clipToLegacy,
  trackToLegacy,
  timelineToLegacy,
} from './timeline.js'

export {
  computeRenderList,
  computeItemLayout,
  computeStageItemLayout,
} from './renderer.js'

export {
  createTransform,
  transformToCSS,
  chainToCSS,
  isKnownTransform,
  migrateEffect,
  effectsToTransforms,
  TRANSFORM_TYPES,
} from './transform.js'

export {
  createTopology,
  addSourceNode,
  addTransformNode,
  addOutputNode,
  connectNodes,
  buildFromTimeline,
  walkTopology,
  getNodesByType,
  getDownstream,
  getUpstream,
  NODE_SOURCE,
  NODE_TRANSFORM,
  NODE_OUTPUT,
} from './topology.js'

// --- Sinks ---

export {
  createDisplaySink,
  createNativeSink,
  createSinkClockAdapter,
} from './sink.js'

// --- Control ---

export { createPresentationClock } from './clock.js'
export { createMediaSession } from './session.js'
