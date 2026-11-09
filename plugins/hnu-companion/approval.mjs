const prefix = 'hnu-qq-approval:'
const key = event => prefix + event
const conflict = message => Object.assign(new Error(message), { status: 409 })

export function bindApprovals({ engine, store, sessions }, canAssess) {
  const decide = engine.decide
  const prompt = sessions.prompt
  const get = event => store.get(key(event))
  const skipped = Symbol('QQ assessment delivery skipped')
  sessions.prompt = async function (session, request, text, mode, authorize, accepted) {
    const id = request.startsWith('candidate:') && JSON.parse(text).trigger_id
    if (typeof id !== 'string' || !id.startsWith('hnu-qq:')) {
      return prompt.call(this, session, request, text, mode, authorize, accepted)
    }
    try {
      await prompt.call(this, session, request, text, mode, () => {
        authorize?.()
        const active = engine.candidate(id)
        if (!active || request !== 'candidate:' + active.evalId) throw skipped
        const trigger = active.triggers.find(item => item.id === id)
        if (trigger && canAssess(trigger)) return
        decide.call(engine, id, { kind: 'ignore', evalId: active.evalId, reason: 'QQ 监听已结束或发起权限已变化' })
        throw skipped
      }, accepted)
    } catch (error) {
      if (error !== skipped) throw error
    }
  }
  engine.decide = function (id, outcome) {
    const trigger = store.triggers.get(id)
    if (trigger?.source !== 'hnu-qq') return decide.call(this, id, outcome)
    if (trigger.meta.manual) {
      if (outcome.kind !== 'accept') return decide.call(this, id, outcome)
      if (outcome.reason?.code !== 'explicitRouted' || !canAssess(trigger)) throw conflict('手动开单权限已变化')
      return decide.call(this, id, { ...outcome, scope: trigger.meta.scope })
    }
    const observed = outcome.kind === 'ignore' && outcome.audit?.would_accept === true && outcome.audit.proposal
    const proposed = outcome.kind === 'accept' ? outcome : observed
    if (!proposed) return decide.call(this, id, outcome)
    if (!outcome.evalId) throw conflict('QQ 工单须先通过评估和人工审批')
    const { eventId } = trigger.meta
    return store.atomic(() => {
      const audit = { ...outcome.audit, would_accept: true }
      const allowed = canAssess(trigger) && !get(eventId)
      const result = decide.call(this, id, { kind: 'ignore', evalId: outcome.evalId,
        reason: allowed ? '等待本机用户审批开单' : 'QQ 发起权限已变化或消息已审核',
        ...(allowed ? { audit: { ...audit, hnuApproval: outcome.evalId } } : {}) })
      if (allowed && result.kind === 'ignore' && result.audit?.hnuApproval === outcome.evalId) {
        store.set(key(eventId), { eventId, triggerId: id, version: outcome.evalId, status: 'pending',
          title: proposed.title, scope: proposed.scope, name: proposed.name ?? proposed.worktree_name,
          reason: typeof outcome.reason === 'string' ? outcome.reason : outcome.reason?.values?.text, audit })
      }
      return result
    })
  }
  return {
    get,
    pending: account => account ? store.keys(prefix + account + ':').map(name => store.get(name)).filter(item => item?.status === 'pending') : [],
    decide(event, version, action) {
      return store.atomic(() => {
        const proposal = get(event)
        if (!proposal || proposal.version !== version) throw conflict('开单建议已变化，请刷新')
        if (proposal.status === action) return proposal
        if (proposal.status !== 'pending') throw conflict('这条建议已经审核')
        const updated = { ...proposal, status: action }
        if (action === 'approve') {
          const trigger = store.triggers.get(proposal.triggerId)
          if (!trigger || !canAssess(trigger, true)) throw conflict('消息来源或发起权限已变化')
          // The gate sees the operator's explicit approval within this same transaction.
          store.set(key(event), updated)
          const decision = decide.call(engine, proposal.triggerId, { kind: 'accept', title: proposal.title,
            scope: proposal.scope, name: proposal.name, reason: '本机用户批准开单', audit: proposal.audit })
          if (decision.kind !== 'accept' || !decision.ticketId) throw conflict('DSSA 未能创建工单，请刷新后重试')
          updated.ticket = decision.ticketId
        }
        store.set(key(event), updated)
        return updated
      })
    },
    dispose() { engine.decide = decide; sessions.prompt = prompt },
  }
}
