import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'correct-horse-battery'
const REAL_PW = 'Sommar2024!'
const REAL_SERVER = 'dc01.corp.contoso.se'
/** Outside the reserved namespace on purpose: the guard must still let it out. */
const CHOSEN_EXAMPLE = 'web-frontend.acme-demo.net'

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

/** The default first run: no password, straight into the app. */
async function startWithoutPassword(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Skapa ditt valv' })).toBeVisible()
  await page.getByRole('button', { name: 'Kom igång direkt' }).click()
  await expect(page.getByRole('heading', { name: 'Skript', exact: true })).toBeVisible({ timeout: 30_000 })
}

test('core loop: open vault, import from editor, copy both ways, new version, add password, lock and unlock', async ({ page }) => {
  await page.goto('/')

  // --- setup: the default is no password at all
  await startWithoutPassword(page)
  await expect(page.locator('.cv-header-right')).toContainText('Oskyddat')
  await expect(page.getByRole('button', { name: /Lås/ })).toHaveCount(0)

  // --- first paste: from the editor, real values inside
  await page.locator('textarea.cv-paste-area').fill(EDITOR_PASTE)
  await page.getByLabel(/Ja, den kommer från min editor/).check()
  await page.getByRole('button', { name: 'Analysera', exact: true }).click()

  // unknown real values are listed: the username, the password and the server
  await expect(page.locator('.cv-group-unknown')).toBeVisible()
  const unknownRows = page.locator('.cv-group-unknown .cv-row')
  await expect(unknownRows).toHaveCount(3)

  // the code is shown beside the list, every finding marked — the three unknown
  // values plus the path the detector picked up as a candidate
  const codePane = page.locator('.cv-review-code')
  await expect(codePane).toBeVisible()
  await expect(page.locator('.cv-find')).toHaveCount(4)
  // The password is not merely hidden: it is not in the document at all.
  await expect(codePane).not.toContainText(REAL_PW)
  await expect(codePane).toContainText('••')
  // Identifying values stay readable, so you can match them against the code.
  await expect(codePane).toContainText(REAL_SERVER)
  await expect(codePane).toContainText('svc-adsync')

  // stepping moves the active mark; clicking a mark selects its row
  await expect(page.locator('.cv-find-active')).toHaveCount(0)
  await page.getByRole('button', { name: /Nästa fynd/ }).click()
  await expect(page.locator('.cv-find-active')).toHaveCount(1)
  await expect(page.locator('.cv-review-nav')).toContainText('Fynd 1/4')
  await page.getByRole('button', { name: /Nästa fynd/ }).click()
  await expect(page.locator('.cv-review-nav')).toContainText('Fynd 2/4')
  await expect(page.locator('.cv-row-active')).toHaveCount(1)
  await page.locator('.cv-find').first().click()
  await expect(page.locator('.cv-review-nav')).toContainText('Fynd 1/4')

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

  // register the server as a field too, and choose its example value by hand
  const srvRow = unknownRows.filter({ hasText: 'rad 4' })
  await srvRow.getByRole('button', { name: 'Skapa fält' }).click()
  await form.locator('input.cv-input').first().fill('DC')
  const exampleInput = form.getByLabel('Exempelvärde (det AI:n ser)')
  await expect(exampleInput).toHaveValue('SRV-EXAMPLE01.corp.example')
  // The vault's own real value can never become what the AI sees.
  await exampleInput.fill(REAL_SERVER)
  await expect(form.getByRole('button', { name: 'Skapa fält' })).toBeDisabled()
  await exampleInput.fill(CHOSEN_EXAMPLE)
  await expect(form.getByRole('button', { name: 'Skapa fält' })).toBeEnabled()
  await form.getByRole('button', { name: 'Skapa fält' }).click()
  await expect(srvRow.locator('.cv-chip-accept')).toBeVisible()

  await page.getByRole('button', { name: 'Spara version' }).click()

  // --- script view: pills for both fields, sanitized copy
  await expect(page.locator('.cv-editor')).toBeVisible()
  await expect(page.locator('.cv-pill')).toHaveCount(3)

  // identifying values are readable, secrets are not
  const dcField = page.locator('.cv-field', { hasText: 'DC' })
  await expect(dcField).toContainText(REAL_SERVER)
  await expect(dcField.getByRole('button', { name: 'Visa i 10 s' })).toHaveCount(0)
  const pwField = page.locator('.cv-field', { hasText: 'SVC_PW' })
  await expect(pwField).not.toContainText(REAL_PW)
  await expect(pwField.getByRole('button', { name: 'Visa i 10 s' })).toBeVisible()
  await page.getByRole('button', { name: /Kopiera för AI/ }).click()
  await expect.poll(() => readClipboard(page)).toContain('Ex@mple-Passw0rd-1')
  const aiCopy = await readClipboard(page)
  // A chosen example leaves through the leak guard like any other fake.
  expect(aiCopy).toContain(CHOSEN_EXAMPLE)
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
  await expect.poll(async () => (await readClipboard(page)).trim()).toBe('')

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

  // the changes tab: what this version does to v1, before it is saved
  await expect(modal.locator('.cv-review-summary .cv-chip', { hasText: /\+\d+ −\d+/ })).toBeVisible()
  await modal.getByRole('tab', { name: /Ändringar mot v1/ }).click()
  await expect(modal.locator('.cv-review-diff .cm-content').first()).toBeVisible()
  await expect(modal.locator('.cv-review-diff')).toContainText('⟦SVC_PW⟧')
  await expect(modal.locator('.cv-review-diff')).not.toContainText(REAL_PW)
  // Deliberately not offered here: unresolved secrets live in this very step.
  await expect(modal.getByRole('button', { name: /Visa riktiga värden/ })).toHaveCount(0)
  await modal.getByRole('tab', { name: 'Fynd' }).click()
  await expect(modal.locator('.cv-review-code')).toBeVisible()

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
  await expect.poll(() => readClipboard(page)).toContain('$AdminPassword')
  expect(await readClipboard(page)).not.toContain(REAL_PW)

  // --- the Värden page: three lists, and the preset library feeds the field form
  await page.getByRole('button', { name: 'Värden' }).click()
  const personal = page.locator('.cv-card', { has: page.getByRole('heading', { name: 'Mina personliga värden' }) })
  await expect(personal).toContainText('SVC_USER')
  await expect(personal).toContainText(REAL_SERVER)
  await expect(personal).not.toContainText(REAL_PW)

  const ai = page.locator('.cv-card', { has: page.getByRole('heading', { name: 'Värden AI:n kan ta emot' }) })
  await expect(ai).toContainText(CHOSEN_EXAMPLE)
  await expect(ai).not.toContainText(REAL_PW)
  await expect(ai).not.toContainText(REAL_SERVER)
  // Save one of the examples in use into the library.
  await ai.locator('.cv-row', { hasText: CHOSEN_EXAMPLE }).getByRole('button', { name: 'Spara i biblioteket' }).click()
  await expect(ai.locator('.cv-row', { hasText: CHOSEN_EXAMPLE })).toHaveCount(2)

  const universal = page.locator('.cv-card', { has: page.getByRole('heading', { name: 'Universella värden' }) })
  await expect(universal).toContainText('DC')

  await page.getByRole('button', { name: 'Skript' }).click()
  await page.locator('.cv-script-row').click()

  // --- locking is off until the vault is given a password
  await page.keyboard.press('Control+Shift+L')
  await expect(page.getByRole('heading', { name: 'Lås upp valvet' })).toHaveCount(0)

  // --- opt in to a master password from Settings; no data is re-encrypted
  await page.getByRole('button', { name: 'Inställningar' }).click()
  const security = page.locator('.cv-card', { has: page.getByRole('heading', { name: 'Säkerhet' }) })
  await expect(security.locator('.cv-callout-warn')).toBeVisible()
  const newSecrets = security.locator('input.cv-secret')
  await newSecrets.nth(0).fill(PASSWORD)
  await newSecrets.nth(1).fill(PASSWORD)
  await security.getByRole('button', { name: 'Lägg till master-lösenord' }).click()
  await expect(page.getByRole('heading', { name: 'Din återställningsnyckel' })).toBeVisible({ timeout: 30_000 })
  expect((await page.locator('pre.cv-recovery').innerText()).trim()).toMatch(/^([0-9A-F]{4}-){7}[0-9A-F]{4}$/)
  await page.getByRole('button', { name: 'Stäng' }).click()
  await expect(page.locator('.cv-header-right')).not.toContainText('Oskyddat')

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

test('a vault reopens by itself on reload while it has no password', async ({ page }) => {
  await page.goto('/')
  await startWithoutPassword(page)
  await page.locator('textarea.cv-paste-area').fill("$Server = 'dc01.corp.contoso.se'")
  await page.getByLabel(/Ja, den kommer från min editor/).check()
  await page.getByRole('button', { name: 'Analysera', exact: true }).click()
  await page.locator('.cv-group-unknown .cv-row').first().getByRole('button', { name: 'Skapa fält' }).click()
  const form = page.locator('.cv-modal form')
  await form.locator('input.cv-input').first().fill('DC')
  await form.getByRole('button', { name: 'Skapa fält' }).click()
  await page.getByRole('button', { name: 'Spara version' }).click()
  await expect(page.locator('.cv-editor')).toBeVisible()

  await page.reload()
  // no unlock screen: straight back to the script that was there before
  await expect(page.getByRole('heading', { name: 'Skript', exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.cv-script-row')).toHaveCount(1)
})

test('sanitize pane replaces known values and the guard blocks unknown ones', async ({ page }) => {
  await page.goto('/')
  // each test gets a fresh browser context, so the vault is always created here
  await startWithoutPassword(page)

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
