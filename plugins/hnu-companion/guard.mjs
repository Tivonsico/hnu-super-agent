export const inject = ['tools']

const evaluation = new Set(['orchestrator_eval', 'orchestrator_eval_read', 'orchestrator_eval_decide', 'orchestrator_read', 'orchestrator_route'])
const execution = new Set(['hnu_read_task', 'hnu_read_image', 'hnu_write_outline', 'orchestrator_report', 'orchestrator_read'])

export function denyManagedTool({ agent, name, arguments: args }) {
  const id = agent?.id
  if (id?.startsWith('orchestrator-') && !evaluation.has(name)
    || id?.startsWith('worker-') && !execution.has(name)) return 'HNU managed sessions cannot use this tool'
  if (id?.startsWith('orchestrator-') && name === 'orchestrator_route'
    && (!Array.isArray(args?.decisions) || !args.decisions.every(decision =>
      /^hnu-qq:[^/]+$/.test(decision?.trigger_id ?? '') && (decision.kind === 'ignore'
        || decision.kind === 'accept' && decision.trigger_id.endsWith(':manual'))))) {
    return 'HNU permits direct acceptance only for operator-confirmed QQ requests'
  }
  if (id?.startsWith('orchestrator-') && name === 'orchestrator_eval_read'
    && (!/^hnu-qq:[^/]+$/.test(args?.trigger_id ?? '') || !['thread', 'root', 'parent', 'message'].includes(args?.resource))) {
    return 'HNU evaluation can read only the authorized QQ discussion'
  }
  if ((id?.startsWith('orchestrator-') || id?.startsWith('worker-')) && name === 'orchestrator_read'
    && (typeof args?.resource !== 'string' || /^(github|feishu)\//.test(args.resource.trim()))) {
    return 'HNU managed sessions cannot use external source resources'
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(denyManagedTool), 'HNU managed session tool boundary')
}
