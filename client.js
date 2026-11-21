/**
 * Plugins-page form for the `im-cron-agent` row (Web → 插件 → dsh-im-cron).
 *
 * Hand-written client module: the browser module table supplies React, the
 * Plugins page supplies the row's staged form (`state` + `mutate`). Saving
 * writes the profile patch and the Loader re-applies the row, so the next agent
 * task run reads the new values.
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-cron',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const FIELDS = [
      ['cwd', '工作目录', '任务会话的 cwd，例如 ~/.dsh/im；留空 = DSH 进程 cwd'],
      ['agentPreset', 'Agent preset', '例如 standard；留空 = 部署默认'],
      ['provider', '模型提供方', '例如 deepseek-account；留空 = 跟随部署默认'],
      ['model', '模型', '例如 deepseek-flash；留空 = 跟随部署默认'],
      ['reasoningEffort', '推理等级', '例如 high；留空 = 跟随 provider 默认'],
      ['permissionPreset', '任务会话权限档', '留空 = 跟随部署默认'],
    ]

    const PERMISSION_OPTIONS = [
      ['', '跟随部署默认'],
      ['workspace-write', 'workspace-write（沙箱内，需审批）'],
      ['danger-full-access', 'danger-full-access（无沙箱，不审批）'],
    ]

    const styles = {
      form: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontWeight: 600, fontSize: '13px' },
      input: {
        padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, #c9ced6)',
        background: 'var(--dsh-surface, transparent)', color: 'inherit', fontSize: '13px',
      },
      hint: { opacity: 0.65, fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: { padding: '6px 14px', borderRadius: '6px', border: '1px solid var(--dsh-border, #c9ced6)', cursor: 'pointer' },
      title: { margin: 0, fontSize: '15px' },
      note: { margin: 0, fontSize: '12px', opacity: 0.7 },
    }

    const inputStyle = styles.input
    const fieldStyle = styles.field

    function valuesOf(state) {
      const value = state?.value ?? {}
      const out = {}
      for (const [field] of FIELDS) out[field] = typeof value[field] === 'string' ? value[field] : ''
      return out
    }

    function describe(value) {
      const parts = []
      if (value.cwd) parts.push(`cwd=${value.cwd}`)
      if (value.agentPreset) parts.push(`preset=${value.agentPreset}`)
      if (value.provider && value.model) parts.push(`model=${value.provider}/${value.model}`)
      if (value.reasoningEffort) parts.push(`effort=${value.reasoningEffort}`)
      if (value.permissionPreset) parts.push(`权限档=${value.permissionPreset}`)
      return parts.length === 0 ? '默认（跟随部署配置）' : parts.join(' · ')
    }

    function AgentSettings(props) {
      const { view, form } = props
      const state = form?.state
      const accepted = valuesOf(state)
      const acceptedKey = JSON.stringify(accepted)
      const [draft, setDraft] = React.useState(accepted)
      const [status, setStatus] = React.useState('idle')

      React.useEffect(() => {
        setDraft(valuesOf(state))
      }, [acceptedKey])

      if (view === 'summary') return h('span', null, describe(accepted))
      if (form === undefined || state === undefined) return h('p', null, '这个插件还没有可编辑的配置。')

      const disabled = state.writable === false || status === 'saving'

      const submit = async (event) => {
        event.preventDefault()
        setStatus('saving')
        try {
          const ops = []
          for (const [field] of FIELDS) {
            const value = String(draft[field] ?? '').trim()
            ops.push(value === '' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value })
          }
          const acceptedWrite = await form.mutate(ops, state.revision)
          setStatus(acceptedWrite ? 'saved' : 'failed')
        } catch {
          setStatus('failed')
        }
      }

      return h('form', { onSubmit: submit, style: styles.form },
        h('h3', { style: styles.title }, 'agent 任务会话'),
        h('p', { style: styles.note }, '保存后需要重启 DSH 才会生效；重启后下一次任务执行按新配置重建会话。留空表示跟随部署默认。'),
        ...FIELDS.map(([field, label, hint]) => h('label', { key: field, style: fieldStyle },
          h('span', { style: styles.label }, label),
          field === 'permissionPreset'
            ? h('select', {
              value: draft[field] ?? '',
              disabled,
              style: inputStyle,
              onChange: (event) => setDraft({ ...draft, [field]: event.target.value }),
            }, ...PERMISSION_OPTIONS.map(([value, text]) => h('option', { key: value, value }, text)))
            : h('input', {
              value: draft[field] ?? '',
              disabled,
              placeholder: hint,
              style: inputStyle,
              onChange: (event) => setDraft({ ...draft, [field]: event.target.value }),
            }),
          h('small', { style: styles.hint }, hint))),
        h('div', { style: styles.row },
          h('button', { type: 'submit', disabled, style: styles.button }, status === 'saving' ? '保存中…' : '保存'),
          status === 'saved' ? h('span', { style: styles.hint }, '已保存，重启 DSH 后生效') : null,
          status === 'failed' ? h('span', { style: styles.hint }, '保存失败，请重试') : null))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-im-cron#im-cron-agent',
        }, AgentSettings))
      },
    }
  },
})
