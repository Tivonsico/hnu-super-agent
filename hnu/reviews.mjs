import { DatabaseSync } from 'node:sqlite'

export class ReviewConflict extends Error {
  status = 409
}

export function openReviews(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS deliveries (
      ticket TEXT NOT NULL, version INTEGER NOT NULL, assignment TEXT NOT NULL,
      base TEXT NOT NULL, sha TEXT NOT NULL, diff TEXT NOT NULL, checks TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, action TEXT, note TEXT, decided_at TEXT,
      PRIMARY KEY(ticket, version), UNIQUE(ticket, assignment)
    );
  `)
  db.exec(`CREATE TABLE IF NOT EXISTS qq_changes (
    event TEXT PRIMARY KEY, ticket TEXT NOT NULL, version INTEGER NOT NULL
  )`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS manual_requests (event TEXT PRIMARY KEY, scope TEXT NOT NULL, materials TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ticket_inputs (
      operation TEXT PRIMARY KEY, ticket TEXT NOT NULL, event TEXT UNIQUE, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
    );
  `)
  const columns = new Set(db.prepare('PRAGMA table_info(deliveries)').all().map(column => column.name))
  if (!columns.has('reviewer')) db.exec('ALTER TABLE deliveries ADD COLUMN reviewer TEXT')
  if (!columns.has('superseded')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0')
  }
  const latest = db.prepare('SELECT * FROM deliveries WHERE ticket = ? ORDER BY version DESC LIMIT 1')
  const assignment = db.prepare('SELECT * FROM deliveries WHERE ticket = ? AND assignment = ?')
  const view = row => row && ({
    ticket: row.ticket, assignment: row.assignment, version: row.version, base: row.base,
    commit: row.sha, diff: row.diff, checks: JSON.parse(row.checks), status: row.superseded && !row.action ? 'superseded' : row.action ?? 'pending', superseded: Boolean(row.superseded),
    note: row.note, reviewer: row.reviewer, decidedAt: row.decided_at, createdAt: row.created_at,
  })
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return {
    close: () => db.close(),
    manualRequest(event) {
      const row = db.prepare('SELECT * FROM manual_requests WHERE event = ?').get(event)
      return row && { scope: row.scope, materialIds: JSON.parse(row.materials) }
    },
    request(event, scope, materialIds) {
      db.prepare('INSERT OR IGNORE INTO manual_requests VALUES (?, ?, ?)').run(event, scope, JSON.stringify(materialIds))
    },
    inputs: ticket => db.prepare('SELECT operation, event, text, delivered FROM ticket_inputs WHERE ticket = ? ORDER BY rowid').all(ticket),
    pendingInputs: () => db.prepare('SELECT * FROM ticket_inputs WHERE delivered = 0 ORDER BY rowid').all(),
    input: operation => db.prepare('SELECT * FROM ticket_inputs WHERE operation = ?').get(operation),
    linked: event => db.prepare('SELECT ticket FROM ticket_inputs WHERE event = ?').get(event)?.ticket,
    addInput({ operation, ticket, event = null, text }) {
      return transaction(() => {
        const current = db.prepare('SELECT * FROM ticket_inputs WHERE operation = ? OR event = ?').get(operation, event)
        if (current) {
          if (current.ticket !== ticket || current.text !== text) throw new ReviewConflict('此消息已关联或已提交')
          return current
        }
        db.prepare('INSERT INTO ticket_inputs (operation, ticket, event, text) VALUES (?, ?, ?, ?)').run(operation, ticket, event, text)
        const delivery = latest.get(ticket)
        if (delivery) {
          db.prepare('UPDATE deliveries SET superseded = 1 WHERE ticket = ? AND version = ?').run(ticket, delivery.version)
        }
        return { operation, ticket, event, text }
      })
    },
    deliverInput: operation => db.prepare('UPDATE ticket_inputs SET delivered = 1 WHERE operation = ?').run(operation),
    ownerContinued: ticket => latest.get(ticket)?.action === 'revise'
      || Boolean(db.prepare('SELECT 1 FROM ticket_inputs WHERE ticket = ? LIMIT 1').get(ticket)),
    current: ticket => view(latest.get(ticket)),
    forAssignment: (ticket, id) => view(assignment.get(ticket, id)),
    history: ticket => db.prepare('SELECT * FROM deliveries WHERE ticket = ? ORDER BY version DESC').all(ticket).map(view),
    revisions: () => db.prepare("SELECT * FROM deliveries WHERE action IN ('revise', 'qq-change') AND version = (SELECT max(version) FROM deliveries d WHERE d.ticket = deliveries.ticket)").all().map(view),
    deliver(value) {
      return transaction(() => {
        const previous = assignment.get(value.ticket, value.assignment)
        if (previous) {
          if (previous.sha !== value.commit) throw new ReviewConflict('该轮执行已有交付快照')
          return view(previous)
        }
        const current = latest.get(value.ticket)
        if (current && !current.superseded && !['revise', 'qq-change'].includes(current.action)) throw new ReviewConflict('仅可在要求修改后登记新版')
        db.prepare('INSERT INTO deliveries (ticket, version, assignment, base, sha, diff, checks) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(value.ticket, (current?.version ?? 0) + 1, value.assignment, value.base, value.commit, value.diff, JSON.stringify(value.checks))
        return view(latest.get(value.ticket))
      })
    },
    qqChanges: (ticket, throughVersion) => db.prepare('SELECT event FROM qq_changes WHERE ticket = ? AND version <= ?')
      .all(ticket, throughVersion).map(row => row.event),
    hasQQChange: event => Boolean(db.prepare('SELECT 1 FROM qq_changes WHERE event = ?').get(event)),
    qqChange({ ticket, version, event, text }) {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM qq_changes WHERE event = ?').get(event)) return 'continued'
        const current = latest.get(ticket)
        if (!current || current.version !== version || current.action) return 'needs_confirmation'
        db.prepare("UPDATE deliveries SET action = 'qq-change', note = ?, decided_at = CURRENT_TIMESTAMP WHERE ticket = ? AND version = ?")
          .run(text, ticket, version)
        db.prepare('INSERT INTO qq_changes (event, ticket, version) VALUES (?, ?, ?)').run(event, ticket, version)
        return 'continued'
      })
    },
    decide({ ticket, version, commit, action, note }, reviewer = '本机用户') {
      if (!['approve', 'reject', 'revise'].includes(action) || (action === 'revise' && !note?.trim())) {
        throw Object.assign(new Error('请选择审批动作并填写修改意见'), { status: 400 })
      }
      return transaction(() => {
        const current = latest.get(ticket)
        if (!current || current.superseded || current.version !== version || current.sha !== commit) throw new ReviewConflict('交付版本已变化，请刷新')
        const comment = note?.trim() || null
        if (current.action === action && current.note === comment) return view(current)
        if (current.action) throw new ReviewConflict('这版交付已有审批记录')
        if (action === 'approve' && !JSON.parse(current.checks).every(check => check.exitCode === 0)) {
          throw new ReviewConflict('本地检查未通过')
        }
        db.prepare('UPDATE deliveries SET action = ?, note = ?, reviewer = ?, decided_at = CURRENT_TIMESTAMP WHERE ticket = ? AND version = ?')
          .run(action, comment, reviewer, ticket, version)
        return view(latest.get(ticket))
      })
    },
  }
}
