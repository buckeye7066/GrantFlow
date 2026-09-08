import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(relPath) {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8')
}

/**
 * Owner report 2026-09-07: the "Profile facts — NEXT STEP" workspace card did
 * nothing visible. It is a Radix tab trigger for the profile tab, which is
 * normally already the active tab, so selecting it again changed nothing and
 * the section cards sat far below the fold. The card must OPEN the profile
 * sections so the person can finish filling them in.
 */
test('ProfileDetail: the "Profile facts" card opens the section editor, not just the (already active) tab', () => {
  const src = read('src/pages/ProfileDetail.jsx')

  // The trigger exposes a click hook on top of tab selection.
  const trigger = src.slice(src.indexOf('function WorkspaceTabTrigger('), src.indexOf('function ProfileWorkspaceNav('))
  assert.ok(trigger.includes('onSelect,'), 'WorkspaceTabTrigger accepts onSelect')
  assert.ok(trigger.includes('onClick={onSelect}'), 'WorkspaceTabTrigger forwards onSelect as the TabsTrigger onClick')

  // The nav hands the hook to the profile card only.
  const nav = src.slice(src.indexOf('function ProfileWorkspaceNav('), src.indexOf('export function WorkAreaLinkCard('))
  assert.ok(nav.includes('onOpenProfileFacts'), 'ProfileWorkspaceNav accepts onOpenProfileFacts')
  assert.ok(
    nav.includes('onSelect={tab.value === "profile" ? onOpenProfileFacts : undefined}'),
    'only the profile card gets the open-sections hook',
  )

  // ProfileDetail opens the next unfilled section (or the first one) on that click.
  const handler = src.slice(src.indexOf('const openProfileFacts = React.useCallback('), src.indexOf('}, [goToWorkspaceTab, nextEmptySection'))
  assert.ok(handler.includes('goToWorkspaceTab("profile")'), 'the click still lands on the profile tab')
  assert.ok(
    handler.includes('nextEmptySection ?? profileCompletion.applicableSectionKeys?.[0]'),
    'the editor targets the next empty section, then the first applicable one',
  )
  assert.ok(handler.includes('handleOpenSection(target)'), 'the section editor is opened')
  assert.ok(src.includes('onOpenProfileFacts={openProfileFacts}'), 'ProfileDetail wires the handler into the nav')
  assert.ok(src.includes('onCompleteProfile={openProfileFacts}'), 'the Complete-profile chip shares the same behavior')
})
