import { describe, expect, it } from 'vitest'
import { emitOpportunityChangeNotifications } from '../services/notificationService.js'

function notificationDb() {
  const inserted = new Map()
  return {
    dialect: 'sqlite',
    inserted,
    prepare(sql) {
      if (sql.includes('SELECT 1 FROM notifications')) {
        return { get: async () => ({ ok: 1 }) }
      }
      if (sql.includes('FROM saved_grants')) {
        return { all: async () => [{ user_id: 'user-1', profile_id: 'profile-1' }] }
      }
      if (sql.includes('FROM grants g')) {
        return { all: async () => [
          { user_id: 'user-1', profile_id: 'profile-1' },
          { user_id: 'user-2', profile_id: 'profile-2' },
        ] }
      }
      if (sql.includes('FROM grant_applications')) {
        return { all: async () => [] }
      }
      if (sql.includes('INSERT INTO notifications')) {
        return {
          run: async (id, userId, title, message, data) => {
            if (inserted.has(id)) return { changes: 0 }
            inserted.set(id, { id, userId, title, message, data: JSON.parse(data) })
            return { changes: 1 }
          },
        }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
  }
}

describe('opportunity change notifications', () => {
  it('notifies saved and pipeline-linked users once per status/deadline transition', async () => {
    const db = notificationDb()
    const change = {
      opportunityId: 'opp-1',
      title: 'Community Resilience Program',
      changedFields: ['source_status', 'deadline'],
      beforeValues: { source_status: 'forecasted', deadline: '2026-09-01' },
      afterValues: { source_status: 'open', deadline: '2026-10-01' },
      currentStatus: 'open',
      statusLabel: 'Open',
      deadline: '2026-10-01',
    }

    await expect(emitOpportunityChangeNotifications(db, change)).resolves.toEqual({ created: 2, recipients: 2 })
    await expect(emitOpportunityChangeNotifications(db, change)).resolves.toEqual({ created: 0, recipients: 2 })
    expect(db.inserted.size).toBe(2)
    for (const notification of db.inserted.values()) {
      expect(notification.title).toBe('Opportunity updated: Community Resilience Program')
      expect(notification.message).toContain('Status is now Open')
      expect(notification.message).toContain('Deadline changed from 2026-09-01 to 2026-10-01')
      expect(notification.data).toMatchObject({
        opportunity_id: 'opp-1',
        changed_fields: ['source_status', 'deadline'],
        current_status: 'open',
      })
    }
  })

  it('does not notify for verification-only history', async () => {
    const db = notificationDb()
    await expect(emitOpportunityChangeNotifications(db, {
      opportunityId: 'opp-1',
      changedFields: ['last_verified_at'],
    })).resolves.toEqual({ created: 0, recipients: 0 })
    expect(db.inserted.size).toBe(0)
  })
})
