import { test, expect, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridge } from '../../src/host/server/transport/bridge.ts'
import { NodeTelemetry } from '../../src/platform/telemetry/telemetry.ts'
import { terminalHost } from '../helpers/terminal-host.ts'

async function drag(page: Page, dx: number, release = true) {
  const handle = page.locator('[data-side="rightbar"]')
  const box = await handle.boundingBox()
  if (!box) throw new Error('Right panel handle missing')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 6 })
  if (release) await page.mouse.up()
}

test('right panel drag previews, cancels, focuses workspace and collapses', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-rightbar-drag-'))
  const { host } = terminalHost(directory)
  const bridge = await startBridge(host, fileURLToPath(new URL('../../web/dist/', import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: 'false' }, monitor: false }))
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => localStorage.setItem('pi-web-locale', 'en'))
  await page.setViewportSize({ width: 1440, height: 900 })
  const panel = page.locator('[data-sidebar-right-session]')
  const frame = page.locator('[data-rightbar-elastic]')
  try {
    await page.goto(bridge.url)
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'push')
    // A normal resize must not collapse the panel.
    await drag(page, 120)
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'push')
    await expect(panel).toHaveAttribute('data-sidebar-right-open', 'true')
    // Overshoot left, then drag back: no action on release.
    const handle = page.locator('[data-side="rightbar"]')
    const box = await handle.boundingBox()
    if (!box) throw new Error('Right panel handle missing')
    const x = box.x + 4, y = box.y + box.height / 2
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(650, y, { steps: 8 })
    await expect(frame).toHaveAttribute('data-rightbar-elastic', 'focus')
    await expect(page.getByText('Keep dragging to focus workspace')).toBeVisible()
    const resisted = await handle.boundingBox()
    expect(resisted!.x).toBeGreaterThan(650 + 4)
    await page.mouse.move(x, y, { steps: 8 }); await page.mouse.up()
    await expect(frame).toHaveCount(0)
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'push')
    // Crossing the threshold acts while the pointer is still down.
    await drag(page, -900, false)
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'focus')
    await expect(page.getByRole('button', { name: 'New session', exact: true }).first()).toBeVisible()
    const focused = await panel.boundingBox()
    expect(focused!.x).toBeGreaterThan(200)
    expect(focused!.width + focused!.x).toBeCloseTo(1440, 0)
    await page.mouse.up()
    await panel.getByRole('button', { name: 'Exit focus mode' }).click()
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'push')
    // Explicit fullscreen leaves the navigation rail visible and restores its preference.
    const shell = page.locator('[data-rightbar-fullscreen]')
    await panel.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'fullscreen')
    await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true')
    const full = await panel.boundingBox()
    expect(full!.x).toBeCloseTo(56, 0)
    expect(full!.width).toBeCloseTo(1440 - 56, 0)
    await panel.getByRole('button', { name: 'Exit fullscreen' }).click()
    await expect(panel).toHaveAttribute('data-sidebar-right-panel', 'push')
    await expect(page.locator('[data-sidebar-collapsed]')).toHaveCount(0)
    // An already collapsed navigation preference remains collapsed on exit.
    await page.locator('[data-sidebar-toggle]').click()
    await expect(page.locator('[data-sidebar-collapsed]')).toHaveCount(1)
    await panel.getByRole('button', { name: 'Fullscreen', exact: true }).click()
    await panel.getByRole('button', { name: 'Exit fullscreen' }).click()
    await expect(page.locator('[data-sidebar-collapsed]')).toHaveCount(1)
    await page.locator('[data-sidebar-toggle]').click()
    // Overshoot the minimum and restore via the permanent conversation control.
    await drag(page, 900, false)
    await expect(panel).toHaveAttribute('aria-hidden', 'true')
    await page.mouse.up()
    await page.getByRole('button', { name: 'Open right sidebar' }).click()
    await expect(panel).toHaveAttribute('data-sidebar-right-open', 'true')
    expect(errors).toEqual([])
  } finally { try { if (!page.isClosed()) await page.goto('about:blank') } finally { await bridge.close(); await rm(directory, { recursive: true, force: true }) } }
})
