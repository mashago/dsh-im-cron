/**
 * Plugins-page controls for the `im-cron-agent` settings (Web → 插件 → dsh-im-cron).
 *
 * Hand-written client module. The bundle page renders the whole README above
 * its configuration section, so an inline form there would sit far down the
 * page. Instead a "配置任务会话" button joins the page head actions
 * (`plugins.detail.actions`) and opens the six fields in a dialog. The row page
 * (`plugins.row.config`) keeps the same form inline.
 *
 * Both surfaces read the row's client form controller through the
 * `configForms` service. Saves write the profile patch, and the Loader commits
 * volatile values in place, so the next agent task run sees the change without
 * a restart.
 */
window.__ModuleLoader__.load({
  id: 'dsh-im-cron',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PACKAGE_NAME = 'dsh-im-cron'

    const FIELDS = [
      ['cwd', '工作目录', '默认 = 插件状态目录（通常 ~/.dsh/im-cron）'],
      ['agentPreset', 'Agent preset', '默认 = 部署默认 preset（通常是 standard）'],
      ['provider', '模型提供方', '默认 = 部署默认模型路由'],
      ['model', '模型', '默认 = 部署默认模型'],
      ['reasoningEffort', '推理等级', '默认 = provider 默认档'],
      ['permissionPreset', '任务会话权限档', '默认 = 部署默认权限档（通常是 workspace-write + 需审批）'],
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
      overlay: {
        position: 'fixed', inset: 0, zIndex: 1000, padding: '24px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.45)',
      },
      dialog: {
        width: 'min(680px, 100%)', maxHeight: '85vh', overflowY: 'auto', padding: '20px 22px',
        borderRadius: '10px', boxShadow: '0 16px 48px rgba(0, 0, 0, 0.25)',
        background: 'var(--dsh-surface, Canvas)', color: 'inherit',
        border: '1px solid color-mix(in srgb, CanvasText 18%, transparent)',
      },
      dialogHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' },
      groupBox: {
        marginTop: '18px', paddingTop: '16px', display: 'flex', flexDirection: 'column', gap: '6px',
        borderTop: '1px solid var(--dsh-border, #c9ced6)',
      },
      checkboxLabel: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600, fontSize: '13px' },
      close: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '18px', lineHeight: 1, opacity: 0.6, padding: '4px 6px' },
    }

    const inputStyle = styles.input
    const fieldStyle = styles.field

    /** The plugin's client context, needed to reach the settings form service. */
    let clientCtx = null

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

    /** The settings controller for the `im-cron-agent` row, from the client service. */
    function agentFormController() {
      try {
        return clientCtx?.get?.('configForms')?.get('im-cron-agent')
      } catch {
        return undefined
      }
    }

    /** The plugin row's own settings controller (the hot group switch). */
    function pluginFormController() {
      try {
        return clientCtx?.get?.('configForms')?.get('im-cron')
      } catch {
        return undefined
      }
    }

    /** Follow one config form controller; `undefined` until the service answers. */
    function useFormSnapshot(controller) {
      const [snapshot, setSnapshot] = React.useState(() => controller?.getSnapshot())
      React.useEffect(() => {
        if (controller === undefined) return undefined
        const update = () => setSnapshot(controller.getSnapshot())
        update()
        return controller.subscribe(update)
      }, [controller])
      return snapshot
    }

    /** The six fields and their save control, shared by the dialog and the row page. */
    function AgentSettingsForm({ state, mutate, showHeading = true, group }) {
      const accepted = valuesOf(state)
      const acceptedKey = JSON.stringify(accepted)
      const groupKey = JSON.stringify(group?.state?.value?.allowGroup ?? null)
      const [draft, setDraft] = React.useState(accepted)
      const [groupAllowed, setGroupAllowed] = React.useState(() => group?.state?.value?.allowGroup === true)
      const [status, setStatus] = React.useState('idle')

      React.useEffect(() => {
        setDraft(valuesOf(state))
      }, [acceptedKey])

      React.useEffect(() => {
        if (group !== undefined) setGroupAllowed(group.state?.value?.allowGroup === true)
      }, [groupKey])

      const disabled = state.writable === false || status === 'saving'
      const groupDisabled = disabled || group?.state?.writable === false

      const submit = async (event) => {
        event.preventDefault()
        setStatus('saving')
        try {
          const ops = []
          for (const [field] of FIELDS) {
            const value = String(draft[field] ?? '').trim()
            ops.push(value === '' ? { op: 'unset', path: [field] } : { op: 'set', path: [field], value })
          }
          const acceptedWrite = await mutate(ops, state.revision)
          const groupWrite = group === undefined
            ? true
            : await group.mutate([{ op: 'set', path: ['allowGroup'], value: groupAllowed }], group.state.revision)
          setStatus(acceptedWrite && groupWrite ? 'saved' : 'failed')
        } catch {
          setStatus('failed')
        }
      }

      return h('form', { onSubmit: submit, style: styles.form },
        showHeading ? h('h3', { style: styles.title }, 'agent 任务会话') : null,
        h('p', { style: styles.note }, '保存后下一次任务执行即生效（改动会重建该任务的会话）。留空 = 使用下方标注的默认值。'),
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
        group === undefined ? null : h('div', { style: styles.groupBox },
          h('label', { style: styles.checkboxLabel },
            h('input', {
              type: 'checkbox',
              checked: groupAllowed,
              disabled: groupDisabled,
              onChange: (event) => setGroupAllowed(event.target.checked),
            }),
            '允许在群聊里使用定时任务'),
          h('small', { style: styles.hint }, '随「保存」一起提交；关闭后群聊里无法创建任务（脚本任务在群聊里始终禁用）。拨动后需点保存。')),
        h('div', { style: styles.row },
          h('button', { type: 'submit', disabled, style: styles.button }, status === 'saving' ? '保存中…' : '保存'),
          status === 'saved' ? h('span', { style: styles.hint }, '已保存，下次任务执行时生效') : null,
          status === 'failed' ? h('span', { style: styles.hint }, '保存失败，请重试') : null))
    }

    /** Row page: the one-line summary plus the shared form. */
    function AgentSettings(props) {
      const { view, form } = props
      const state = form?.state
      if (view === 'summary') return h('span', null, describe(valuesOf(state)))
      if (form === undefined || state === undefined) return h('p', null, '这个插件还没有可编辑的配置。')
      return h(AgentSettingsForm, { state, mutate: (ops, revision) => form.mutate(ops, revision) })
    }

    /** Page head: a button that opens the settings dialog. */
    function SettingsAction({ subject }) {
      const [open, setOpen] = React.useState(false)
      const controller = open ? agentFormController() : undefined
      const snapshot = useFormSnapshot(controller)
      const pluginController = open ? pluginFormController() : undefined
      const pluginSnapshot = useFormSnapshot(pluginController)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      if (subject?.pkg?.name !== PACKAGE_NAME) return null

      const group = pluginController === undefined || pluginSnapshot?.status !== 'ready'
        ? undefined
        : { state: pluginSnapshot, mutate: (ops, revision) => pluginController.mutate(ops, revision) }

      let body
      if (controller === undefined) {
        body = h('p', { style: styles.note }, '设置服务尚未就绪；刷新页面后再试。')
      } else if (snapshot === undefined || snapshot.status === 'loading') {
        body = h('p', { style: styles.note }, '读取配置…')
      } else if (snapshot.status === 'unavailable') {
        body = h('p', { style: styles.note }, '当前版本没有把 im-cron-agent 的配置暴露给页面。')
      } else {
        body = h(AgentSettingsForm, {
          state: snapshot,
          showHeading: false,
          group,
          mutate: (ops, revision) => controller.mutate(ops, revision),
        })
      }

      return h(React.Fragment, null,
        h('button', { type: 'button', style: styles.button, onClick: () => setOpen(true) }, '配置任务会话'),
        open
          ? h('div', { style: styles.overlay, onClick: () => setOpen(false) },
            h('div', {
              style: styles.dialog,
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '定时任务设置',
              onClick: (event) => event.stopPropagation(),
            },
            h('div', { style: styles.dialogHead },
              h('h3', { style: styles.title }, 'dsh-im-cron 设置'),
              h('button', {
                type: 'button', 'aria-label': '关闭', title: '关闭', style: styles.close, onClick: () => setOpen(false),
              }, '×')),
            body))
          : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
          name: 'plugins.detail.actions',
          id: 'dsh-im-cron-settings',
          order: 20,
        }, SettingsAction))
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: 'dsh-im-cron#im-cron-agent',
        }, AgentSettings))
      },
    }
  },
})