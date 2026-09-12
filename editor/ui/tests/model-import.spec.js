import { test, expect } from '@playwright/test'
import { basename } from 'node:path'
import { writeFile } from 'node:fs/promises'

function triangleGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' },
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  }))
  const jsonLength = Math.ceil(json.length / 4) * 4
  const glb = Buffer.alloc(28 + jsonLength + positions.byteLength)
  glb.write('glTF')
  glb.writeUInt32LE(2, 4)
  glb.writeUInt32LE(glb.length, 8)
  glb.writeUInt32LE(jsonLength, 12)
  glb.writeUInt32LE(0x4e4f534a, 16)
  glb.fill(0x20, 20, 20 + jsonLength)
  json.copy(glb, 20)
  glb.writeUInt32LE(positions.byteLength, 20 + jsonLength)
  glb.writeUInt32LE(0x004e4942, 24 + jsonLength)
  Buffer.from(positions.buffer).copy(glb, 28 + jsonLength)
  return { name: 'triangle.glb', mimeType: 'model/gltf-binary', buffer: glb }
}

// Set CONSTELLATION_TEST_MODEL to exercise the same flow with a local model.
test('renders a GLB timeline clip in Stage and output with transparent geometry', async ({ page, context }, testInfo) => {
  test.setTimeout(90000)
  const file = process.env.CONSTELLATION_TEST_MODEL || triangleGlb()
  const name = typeof file === 'string' ? basename(file) : file.name
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Add New', exact: true }).click()
  const picker = page.waitForEvent('filechooser')
  await page.getByRole('menuitem', { name: 'Add Files…', exact: true }).click()
  await (await picker).setFiles(file)
  const row = page.locator('.media-row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(row.locator('img')).toBeVisible({ timeout: 20000 })
  await row.getByRole('button', { name: 'Insert at playhead' }).click()
  const stageImage = page.locator('.v2d-clip img')
  await expect(stageImage).toBeVisible({ timeout: 30000 })
  await expect.poll(() => visiblePixels(stageImage)).toBeGreaterThan(50000)
  const source = await stageImage.getAttribute('src')
  await writeFile(testInfo.outputPath('model-source.png'), Buffer.from(source.split(',')[1], 'base64'))
  await page.screenshot({ path: testInfo.outputPath('model-on-stage.png') })

  const snapshot = await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store.js')
    const { project, scene, time } = useEditorStore.getState()
    return { project, scene, time, playing: false }
  })
  expect(snapshot.project.timeline.tracks.flatMap(t => t.media)).toHaveLength(1)
  const output = await context.newPage()
  output.on('pageerror', (error) => errors.push(error.message))
  await output.setViewportSize({ width: 1024, height: 1024 })
  await output.goto('/?display=1&w=1024&h=1024')
  // Readiness is the mounted React output. Its message listener is installed
  // in the same effect pass; retry the snapshot until the source appears.
  await expect.poll(async () => {
    await output.evaluate(payload => window.postMessage({ event: 'display:snapshot', payload }, '*'), snapshot)
    return output.locator('img').count()
  }, { timeout: 30000 }).toBe(1)
  await expect.poll(() => visiblePixels(output.locator('img'))).toBeGreaterThan(50000)
  expect(await output.locator('img').getAttribute('src')).toBe(source)
  await output.screenshot({ path: testInfo.outputPath('model-in-output.png') })

  await output.evaluate(() => window.postMessage({ event: 'display:transport', payload: { time: 11, playing: false, seq: 1 } }, '*'))
  await expect(output.locator('img')).toHaveCount(0)
  await page.evaluate(async () => (await import('/src/store.js')).useEditorStore.getState().seek(11))
  await expect(page.locator('.v2d-clip')).toBeHidden()
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0)
  expect(errors).toEqual([])
})

async function visiblePixels(locator) {
  return locator.evaluate(img => {
    if (!img.complete || img.naturalWidth !== 1024) return 0
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1024
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, 1024, 1024).data
    // A blank render / loading placeholder is not a successful import.
    if (pixels[3] !== 0) return 0
    let visible = 0
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 128 && pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) visible++
    }
    return visible
  })
}
