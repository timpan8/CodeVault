import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'correct-horse-battery'
const REAL_PW = 'Sommar2024!'
const REAL_SERVER = 'dc01.corp.contoso.se'

const EDITOR_PASTE = [
  '# Sync users to the lab',
  "$Username = 'svc-adsync'",
  `$Password = '${REAL_PW}'`,
  `Connect-Thing -Server '${REAL_SERVER}' -UserName $Username -Password $Password`,
  "Export-Csv -Path 'C:\\Temp\\AdSync\\users.csv' -NoTypeInformation",
].join('\n')

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

test('core loop: create vault, import from editor, copy both ways, new version, lock and unlock', async ({ page }) => {
  await page.goto('/')

  // --- setup: master password + recovery key
  await expect(page.getByRole('heading', { name: 'Skapa ditt valv' })).toBeVisible()
  const secrets = page.locator('input.cv-secret')
  await secrets.nth(0).fill(PASSWORD)
  await secrets.nth(1).fill(PASSWORD)
  await page.getByRole('button', { name: 'Skapa valv' }).click()
  await expect(page.getByRole('heading', { name: 'Din återställningsnyckel' })).toBeVisible({ timeout: 30_000 })
  const recoveryKey = (await page.locator('pre.cv-recovery').innerText()).trim()
  expect(recoveryKey).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/)
  await page.getByLabel(/Jag har sparat/).check()
  await page.getByRole('button', { name: 'Öppna valvet' }).click()

  // --- first paste: from the editor, real values inside
  await expect(page.getByRole('heading', { name: 'Skript', exact: true })).toBeVisible()
  await page.locator('textarea.cv-paste-area').fill(EDITOR_PASTE)
  await page.getByLabel(/Ja, den kommer från min editor/).check()
  await page.getByRole('button', { name: 'Analysera', exact: true }).click()

  // unknown real values are listed: the username, the password and the server
  await expect(page.locator('.cv-group-unknown')).toBeVisible()
  const unknownRows = page.locator('.cv-group-unknown .cv-row')
  await expect(unknownRows).toHaveCount(3)

  // register the username
  const userRow = unknownRows.filter({ hasText: 'rad 2' })
  await userRow.getByRole('button', { name: 'Skapa fält' }).click()
  const form = page.locator('.cv-modal form')
  await expect(form.locator('select').first()).toHaveValue('username')
  await form.locator('input.cv-input').first().fill('SVC_USER')
  await form.getByRole('button', { name: 'Skapa fält' }).click()
  await expect(userRow.locator('.cv-chip-accept')).toBeVisible()

  // register the password as a field (real value prefilled from the literal)
  const pwRow = unknownRows.filter({ hasText: 'rad 3' })
  await pwRow.getByRole('button', { name: 'Skapa fält' }).click()
  await expect(form.locator('select').first()).toHaveValue('password')
  await form.locator('input.cv-input').first().fill('SVC_PW')
  await form.getByRole('button', { name: 'Skapa fält' }).click()
  await expect(pwRow.locator('.cv-chip-accept')).toBeVisible()

  // register the server as a field too
  const srvRow = unknownRows.filter({ hasText: 'rad 4' })
  await srvRow.getByRole('button', { name: 'Skapa fält' }).click()
  await form.locator('input.cv-input').first().fill('DC')
  await form.getByRole('button', { name: 'Skapa fält' }).click()
  await expect(srvRow.locator('.cv-chip-accept')).toBeVisible()

  await page.getByRole('button', { name: 'Spara version' }).click()

  // --- script view: pills for both fields, sanitized copy
  await expect(page.locator('.cv-editor')).toBeVisible()
  await expect(page.locator('.cv-pill')).toHaveCount(3)
  await page.getByRole('button', { name: /Kopiera för AI/ }).click()
  await expect(page.locator('.cv-toast-ok')).toBeVisible()
  const aiCopy = await readClipboard(page)
  expect(aiCopy).toContain('Ex@mple-Passw0rd-1')
  expect(aiCopy).toContain('SRV-EXAMPLE01.corp.example')
  expect(aiCopy).toContain('svc-example01')
  expect(aiCopy).not.toContain('svc-adsync')
  expect(aiCopy).not.toContain(REAL_PW)
  expect(aiCopy).not.toContain(REAL_SERVER)
  expect(aiCopy).toContain('# Placeholder values')

  // --- real copy: two presses, sentinel + real values, banner
  const realBtn = page.getByRole('button', { name: /Kopiera RIKTIGT/ })
  await realBtn.click()
  await expect(page.getByRole('button', { name: /Tryck igen/ })).toBeVisible()
  await page.getByRole('button', { name: /Tryck igen/ }).click()
  await expect(page.locator('.cv-banner')).toBeVisible()
  const realCopy = await readClipboard(page)
  expect(realCopy.split(/\r?\n/)[0]).toBe('# [REAL VALUES - never paste into AI] v1')
  expect(realCopy).toContain(REAL_PW)
  expect(realCopy).toContain(REAL_SERVER)
  expect(realCopy).toContain('\r\n')
  expect(realCopy).not.toContain('Ex@mple-Passw0rd-1')
  await page.getByRole('button', { name: 'Rensa nu' }).click()
  await expect(page.locator('.cv-banner')).toHaveCount(0)
  expect((await readClipboard(page)).trim()).toBe('')

  // --- new version from the AI: renamed variable, examples kept
  const aiVersion = aiCopy
    .split('\n')
    .filter((l) => !l.startsWith('# Placeholder values'))
    .join('\n')
    .replace('$Password =', '$AdminPassword =')
    .replace('-Password $Password', '-Password $AdminPassword')
    .concat('\nWrite-Host "done"')
  await page.keyboard.press('Control+Shift+N')
  const modal = page.locator('.cv-modal')
  await expect(modal).toBeVisible()
  await modal.locator('textarea').fill(aiVersion)
  await modal.getByRole('button', { name: 'Analysera' }).click()
  await expect(modal.locator('.cv-group-auto')).toBeVisible()
  await expect(modal.locator('.cv-group-auto .cv-row')).toHaveCount(3)
  await expect(modal.locator('.cv-group-unknown')).toHaveCount(0)
  await modal.getByRole('button', { name: 'Spara version' }).click()
  await expect(page.locator('.cv-version')).toHaveCount(2)
  await expect(page.locator('.cv-version-selected')).toContainText('v2')
  await expect(page.locator('.cv-pill')).toHaveCount(3)

  // diff between v1 and v2 on template level: markers, stats, no real values
  await page.keyboard.press('Control+Shift+D')
  const diff = page.locator('.cv-modal')
  await expect(diff).toBeVisible()
  await expect(diff.locator('.cv-diff-host .cm-content').first()).toBeVisible()
  await expect(diff).toContainText('⟦SVC_PW⟧')
  await expect(diff).not.toContainText(REAL_PW)
  await expect(diff.locator('.cv-chip', { hasText: /\+\d+ −\d+/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(diff).toHaveCount(0)

  // sanitized copy of v2 still carries no real value
  await page.getByRole('button', { name: /Kopiera för AI/ }).click()
  const aiCopy2 = await readClipboard(page)
  expect(aiCopy2).toContain('$AdminPassword')
  expect(aiCopy2).not.toContain(REAL_PW)

  // --- lock and unlock
  await page.keyboard.press('Control+Shift+L')
  await expect(page.getByRole('heading', { name: 'Lås upp valvet' })).toBeVisible()
  await page.locator('input.cv-secret').fill('wrong password')
  await page.getByRole('button', { name: 'Lås upp' }).click()
  await expect(page.locator('.cv-callout-error')).toContainText('Fel lösenord')
  await page.locator('input.cv-secret').fill(PASSWORD)
  await page.getByRole('button', { name: 'Lås upp' }).click()
  await expect(page.getByRole('heading', { name: 'Skript', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cv-script-row')).toHaveCount(1)
  await expect(page.locator('.cv-script-row')).toContainText('2 versioner')
})

test('sanitize pane replaces known values and the guard blocks unknown ones', async ({ page }) => {
  await page.goto('/')
  // vault persists in IndexedDB between tests of the same browser context? No: each test gets a fresh context.
  await expect(page.getByRole('heading', { name: 'Skapa ditt valv' })).toBeVisible()
  const secrets = page.locator('input.cv-secret')
  await secrets.nth(0).fill(PASSWORD)
  await secrets.nth(1).fill(PASSWORD)
  await page.getByRole('button', { name: 'Skapa valv' }).click()
  await page.getByLabel(/Jag har sparat/).check({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Öppna valvet' }).click()

  await page.getByRole('button', { name: 'Sanera text' }).click()
  await page.locator('textarea').fill('Get-ADUser : Cannot contact the server dc01.corp.contoso.se\nAt C:\\Users\\tim.pan\\Documents\\sync.ps1:12 char:5\nContact anna.svensson@contoso.se')
  await page.getByRole('button', { name: 'Sanera', exact: true }).click()
  await expect(page.locator('.cv-modal')).toBeVisible()
  const rows = page.locator('.cv-modal .cv-row')
  await expect(rows).toHaveCount(3)
  await expect(page.locator('.cv-modal')).toContainText('host or domain name')
  await expect(page.locator('.cv-modal')).toContainText('user profile path')
  await expect(page.locator('.cv-modal')).toContainText('email address')
})
