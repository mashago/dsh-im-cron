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
 *
 * The provider / model / reasoning-effort fields are chosen from the Host's
 * model catalog (`session/modelCatalog`) as one grouped menu plus an effort
 * menu that only lists the levels the chosen model offers, instead of free
 * text: a typo there fails `selectModel` and silently drops the whole pin.
 * Selections stay drafts until 「保存」, and if the catalog cannot be read the
 * form falls back to the plain text inputs.
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
      warn: { margin: 0, fontSize: '12px', color: 'var(--dsh-danger, #b42318)' },
      picker: { position: 'relative', display: 'flex', flexDirection: 'column' },
      pickerButton: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
        textAlign: 'left', cursor: 'pointer',
      },
      pickerValue: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      pickerChevron: { flex: 'none', opacity: 0.6, fontSize: '11px' },
      menu: {
        position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30,
        maxHeight: '260px', overflowY: 'auto', padding: '4px',
        border: '1px solid var(--dsh-border, #c9ced6)', borderRadius: '8px',
        background: 'var(--dsh-surface, Canvas)', color: 'inherit',
        boxShadow: '0 10px 28px rgba(15, 23, 42, 0.18)',
      },
      menuGroup: { padding: '6px 8px 2px', fontSize: '11px', opacity: 0.6, letterSpacing: '0.04em' },
      menuOption: {
        display: 'flex', flexDirection: 'column', gap: '2px', width: '100%', padding: '6px 8px',
        textAlign: 'left', fontSize: '13px', border: 'none', borderRadius: '6px',
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      menuOptionSelected: { background: 'color-mix(in srgb, CanvasText 9%, transparent)' },
      menuOptionHover: { background: 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, CanvasText 6%, transparent))' },
      menuOptionHint: { fontSize: '11px', opacity: 0.6 },
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

    // ---- model catalog ----------------------------------------------------
    // Only pure helpers live here; the shipped entries are exposed as
    // `internals` below so test/client.test.js can exercise this same file.

    const MAX_ID_LENGTH = 1024
    const MAX_LABEL_LENGTH = 256

    function cleanId(value) {
      if (typeof value !== 'string') return ''
      const id = value.trim()
      return id === '' || id.length > MAX_ID_LENGTH ? '' : id
    }

    function cleanLabel(value, fallback) {
      if (typeof value !== 'string') return fallback
      const label = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
      return label === '' ? fallback : label.slice(0, MAX_LABEL_LENGTH)
    }

    function normalizeReasoning(value) {
      if (value === null || typeof value !== 'object' || !Array.isArray(value.efforts)) return undefined
      const efforts = []
      const seen = new Set()
      for (const level of value.efforts) {
        const id = cleanId(level?.id)
        if (id === '' || seen.has(id)) continue
        seen.add(id)
        const description = cleanLabel(level?.description, '')
        efforts.push({ id, name: cleanLabel(level?.name, id), ...(description === '' ? {} : { description }) })
      }
      if (efforts.length === 0) return undefined
      const defaultEffort = cleanId(value.defaultEffort)
      return { efforts, ...(seen.has(defaultEffort) ? { defaultEffort } : {}) }
    }

    /** Accept either the remote value or the whole `{ok, value}` envelope. */
    function normalizeCatalog(value) {
      const source = value !== null && typeof value === 'object' && value.groups === undefined
        && value.value !== null && typeof value.value === 'object' ? value.value : value
      const groups = []
      const seen = new Set()
      const seenGroups = new Set()
      for (const group of Array.isArray(source?.groups) ? source.groups : []) {
        const id = cleanId(group?.id)
        if (id === '' || seenGroups.has(id)) continue
        const models = []
        for (const model of Array.isArray(group?.models) ? group.models : []) {
          const modelId = cleanId(model?.id)
          if (modelId === '' || seen.has(`${id}\u0000${modelId}`)) continue
          seen.add(`${id}\u0000${modelId}`)
          const description = cleanLabel(model?.description, '')
          const reasoning = normalizeReasoning(model?.reasoning)
          models.push({
            id: modelId,
            name: cleanLabel(model?.name, modelId),
            ...(description === '' ? {} : { description }),
            ...(reasoning === undefined ? {} : { reasoning }),
          })
        }
        if (models.length > 0) {
          seenGroups.add(id)
          groups.push({ id, name: cleanLabel(group?.name, id), models })
        }
      }
      const failures = []
      for (const failure of Array.isArray(source?.failures) ? source.failures : []) {
        const id = cleanId(failure?.id)
        if (id === '') continue
        failures.push({ id, name: cleanLabel(failure?.name, id), message: cleanLabel(failure?.message, '') })
      }
      return { groups, failures }
    }

    function modelEntry(catalog, provider, model) {
      const providerId = cleanId(provider)
      const modelId = cleanId(model)
      if (providerId === '' || modelId === '') return undefined
      const group = catalog?.groups?.find((candidate) => candidate.id === providerId)
      return group?.models.find((candidate) => candidate.id === modelId)
    }

    function effortEntry(entry, effort) {
      const id = cleanId(effort)
      if (id === '' || entry?.reasoning === undefined) return undefined
      return entry.reasoning.efforts.find((level) => level.id === id)
    }

    function effortName(entry, effort) {
      const matched = effortEntry(entry, effort)
      if (matched !== undefined) return matched.name
      return cleanId(effort) === '' ? '' : effort
    }

    /** Menu rows for the model picker; each option carries the draft patch it applies. */
    function modelOptions(catalog, draft) {
      const followDefault = {
        kind: 'option',
        key: 'model:default',
        label: '跟随部署默认',
        description: '由部署的默认模型决定',
        // A half-filled pair is not "following the default": the label says so
        // and the form warns, so the menu must not claim a check mark either.
        selected: cleanId(draft.provider) === '' && cleanId(draft.model) === '',
        patch: { provider: '', model: '', reasoningEffort: '' },
      }
      const options = [followDefault]
      for (const group of catalog?.groups ?? []) {
        options.push({ kind: 'heading', key: `group:${group.id}`, label: group.name })
        for (const model of group.models) {
          options.push({
            kind: 'option',
            key: `model:${group.id}/${model.id}`,
            label: model.name,
            description: model.description ?? `${group.id}/${model.id}`,
            selected: draft.provider === group.id && draft.model === model.id,
            patch: { provider: group.id, model: model.id, reasoningEffort: '' },
          })
        }
      }
      for (const failure of catalog?.failures ?? []) {
        options.push({
          kind: 'option',
          key: `failure:${failure.id}`,
          label: `${failure.name}（目录读取失败）`,
          ...(failure.message === '' ? {} : { description: failure.message }),
          disabled: true,
        })
      }
      return options
    }

    /** Menu rows for the effort picker; only the selected model's levels appear. */
    function effortOptions(entry, effort) {
      const current = cleanId(effort)
      const defaultName = effortName(entry, entry?.reasoning?.defaultEffort)
      const options = [{
        kind: 'option',
        key: 'effort:default',
        label: '跟随模型默认',
        description: defaultName === '' ? '使用模型或服务提供方的默认强度' : `当前模型默认：${defaultName}`,
        selected: current === '',
        patch: { reasoningEffort: '' },
      }]
      for (const level of entry?.reasoning?.efforts ?? []) {
        options.push({
          kind: 'option',
          key: `effort:${level.id}`,
          label: level.name,
          ...(level.description === undefined ? {} : { description: level.description }),
          selected: current === level.id,
          patch: { reasoningEffort: level.id },
        })
      }
      return options
    }

    /** One cached catalog for the page; the remote call is single-flight. */
    const catalogStore = {
      status: 'idle',
      value: null,
      error: null,
      promise: null,
      listeners: new Set(),
    }

    function catalogSnapshot() {
      return { status: catalogStore.status, value: catalogStore.value, error: catalogStore.error }
    }

    function notifyCatalog() {
      for (const listener of [...catalogStore.listeners]) {
        try {
          listener()
        } catch {
          // one broken subscriber must not stop the rest
        }
      }
    }

    function setCatalog(patch) {
      Object.assign(catalogStore, patch)
      notifyCatalog()
    }

    async function fetchCatalog(ctx) {
      // `remote` and `remote.session` are declared in this plugin's inject list:
      // Cordis rejects reading a service face off another service without it.
      const session = ctx?.remote?.session
      if (typeof session?.modelCatalog !== 'function') {
        throw new Error('当前 DSH 没有模型目录接口（session/modelCatalog）')
      }
      const response = await session.modelCatalog()
      if (response !== null && typeof response === 'object' && response.ok === false) {
        const code = response.error?.code ?? 'catalog-failed'
        const message = response.error?.message ?? '模型目录读取失败'
        throw new Error(`${code}: ${message}`)
      }
      const value = response !== null && typeof response === 'object' && response.ok === true
        ? response.value : response
      const catalog = normalizeCatalog(value)
      if (catalog.groups.length === 0) throw new Error('模型目录为空（没有可用的模型提供方）')
      return catalog
    }

    function loadCatalog({ force = false } = {}) {
      if (catalogStore.promise !== null) return catalogStore.promise
      if (!force && catalogStore.status === 'ready' && catalogStore.value !== null) return undefined
      setCatalog({ status: 'loading', error: null })
      const promise = fetchCatalog(clientCtx)
        .then((catalog) => {
          setCatalog({ status: 'ready', value: catalog, error: null, promise: null })
          return catalog
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          setCatalog({ status: 'error', value: null, error: message, promise: null })
          return null
        })
      catalogStore.promise = promise
      return promise
    }

    /**
     * Refetch after a Host event that can change the catalog. Keeps the list
     * already on screen while the request runs — swapping pickers back to text
     * inputs mid-edit would be worse than a slightly stale menu.
     */
    function refreshCatalog() {
      if (catalogStore.listeners.size === 0) {
        // Nothing on screen: drop the cache so the next mount refetches.
        catalogStore.status = 'idle'
        catalogStore.value = null
        catalogStore.error = null
        return
      }
      if (catalogStore.promise !== null) return
      catalogStore.promise = fetchCatalog(clientCtx)
        .then((catalog) => {
          setCatalog({ status: 'ready', value: catalog, error: null, promise: null })
        })
        .catch(() => {
          // Keep the list on screen; an explicit retry still reports the error.
          catalogStore.promise = null
        })
    }

    const CATALOG_EVENTS = [
      'llm/adapters-updated',
      'llm/models-updated',
      'settings/document-updated',
      'credentials/record-updated',
      'credentials/reference-updated',
    ]

    /** Follow Host events that can change the model catalog (providers, keys, defaults). */
    function followCatalogEvents(ctx) {
      const remote = ctx?.remote
      if (typeof remote?.$on !== 'function') return
      const disposers = []
      for (const event of CATALOG_EVENTS) {
        try {
          const dispose = remote.$on(event, refreshCatalog)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch {
          // An unknown event name must not take the settings page down.
        }
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // already disposed with the remote face
            }
          }
        })
      }
    }

    /** Load the catalog once per page and follow store updates. */
    function useModelCatalog() {
      const [snapshot, setSnapshot] = React.useState(catalogSnapshot)
      React.useEffect(() => {
        const listener = () => setSnapshot(catalogSnapshot())
        catalogStore.listeners.add(listener)
        listener()
        loadCatalog()
        return () => {
          catalogStore.listeners.delete(listener)
        }
      }, [])
      return snapshot
    }

    /** Row style: the hovered row lifts, the selected row wins over hover, disabled rows never lift. */
    function optionStyle(option, activeKey) {
      return {
        ...styles.menuOption,
        ...(option.selected === true ? styles.menuOptionSelected : {}),
        ...(option.key === activeKey && option.selected !== true && option.disabled !== true
          ? styles.menuOptionHover : {}),
        ...(option.disabled === true ? { opacity: 0.5, cursor: 'default' } : {}),
      }
    }

    /** Button plus popup menu; options are `heading` rows or selectable `option` rows. */
    function Picker({ value, placeholder, disabled, options, onSelect }) {
      const [open, setOpen] = React.useState(false)
      const [activeKey, setActiveKey] = React.useState(null)
      const rootRef = React.useRef(null)
      const buttonRef = React.useRef(null)

      React.useEffect(() => {
        if (!open) setActiveKey(null)
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (rootRef.current?.contains(event.target) !== true) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          setOpen(false)
          buttonRef.current?.focus()
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const choose = (option) => {
        onSelect(option.patch)
        setOpen(false)
        buttonRef.current?.focus()
      }

      return h('div', { ref: rootRef, style: styles.picker },
        h('button', {
          ref: buttonRef,
          type: 'button',
          disabled,
          style: { ...styles.input, ...styles.pickerButton },
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
        h('span', { style: styles.pickerValue }, value === '' ? placeholder : value),
        h('span', { style: styles.pickerChevron, 'aria-hidden': true }, '▾')),
        open
          ? h('div', { role: 'listbox', style: styles.menu, onMouseLeave: () => setActiveKey(null) },
            ...options.map((option) => option.kind === 'heading'
              ? h('div', { key: option.key, style: styles.menuGroup, role: 'presentation' }, option.label)
              : h('button', {
                key: option.key,
                type: 'button',
                role: 'option',
                'aria-selected': option.selected === true,
                disabled: option.disabled === true,
                style: optionStyle(option, activeKey),
                onMouseEnter: () => {
                  if (option.disabled !== true) setActiveKey(option.key)
                },
                onFocus: () => {
                  if (option.disabled !== true) setActiveKey(option.key)
                },
                onClick: () => choose(option),
              },
              h('span', null, option.selected === true ? `✓ ${option.label}` : option.label),
              option.description === undefined
                ? null
                : h('span', { style: styles.menuOptionHint }, option.description))))
          : null)
    }

    /** The fields and their save control, shared by the dialog and the row page. */
    function AgentSettingsForm({ state, mutate, showHeading = true, group }) {
      const accepted = valuesOf(state)
      const acceptedKey = JSON.stringify(accepted)
      const groupKey = JSON.stringify(group?.state?.value?.allowGroup ?? null)
      const [draft, setDraft] = React.useState(accepted)
      const [groupAllowed, setGroupAllowed] = React.useState(() => group?.state?.value?.allowGroup === true)
      const [status, setStatus] = React.useState('idle')
      const catalogState = useModelCatalog()

      React.useEffect(() => {
        setDraft(valuesOf(state))
      }, [acceptedKey])

      React.useEffect(() => {
        if (group !== undefined) setGroupAllowed(group.state?.value?.allowGroup === true)
      }, [groupKey])

      const disabled = state.writable === false || status === 'saving'
      const groupDisabled = disabled || group?.state?.writable === false

      // A catalog failure must not block saving: the three model fields fall
      // back to their plain text inputs in that case.
      const catalogReady = catalogState.status === 'ready' && catalogState.value !== null
      const entry = catalogReady ? modelEntry(catalogState.value, draft.provider, draft.model) : undefined
      const storedEffort = catalogReady ? effortEntry(entry, draft.reasoningEffort) : undefined

      const providerSet = cleanId(draft.provider) !== ''
      const modelSet = cleanId(draft.model) !== ''
      const effortSet = cleanId(draft.reasoningEffort) !== ''
      // Never claim "following the default" while half of a pair is saved.
      const modelLabel = providerSet && modelSet
        ? entry?.name ?? `${draft.provider}/${draft.model}`
        : providerSet ? `${draft.provider}/（未选模型）`
          : modelSet ? `（未选提供方）/${draft.model}`
            : '跟随部署默认'
      const defaultEffortName = entry?.reasoning?.defaultEffort === undefined
        ? '' : effortName(entry, entry.reasoning.defaultEffort)
      const effortLabel = !effortSet
        ? (defaultEffortName === '' ? '跟随模型默认' : `跟随模型默认（${defaultEffortName}）`)
        : storedEffort?.name ?? draft.reasoningEffort

      const warnings = []
      if (catalogReady) {
        if (providerSet !== modelSet) {
          warnings.push('模型与提供方需成对设置；当前只填了一个，运行时会被忽略。')
        } else if (providerSet && entry === undefined) {
          warnings.push('当前保存的模型不在目录里（provider 可能已下线），请重选或改为跟随部署默认。')
        }
        if (effortSet && entry !== undefined && storedEffort === undefined) {
          warnings.push('当前保存的思考强度不在该模型的可选范围，请重选或留空。')
        }
      }

      const fieldByName = new Map(FIELDS.map((item) => [item[0], item]))

      const textField = (name) => {
        const [, label, hint] = fieldByName.get(name)
        return h('label', { key: name, style: fieldStyle },
          h('span', { style: styles.label }, label),
          h('input', {
            value: draft[name] ?? '',
            disabled,
            placeholder: hint,
            style: inputStyle,
            onChange: (event) => setDraft({ ...draft, [name]: event.target.value }),
          }),
          h('small', { style: styles.hint }, hint))
      }

      const modelField = () => h('div', { key: 'model', style: fieldStyle },
        h('span', { style: styles.label }, '模型'),
        h(Picker, {
          value: modelLabel,
          disabled,
          options: modelOptions(catalogState.value, draft),
          onSelect: (patch) => setDraft({ ...draft, ...patch }),
        }),
        h('small', { style: styles.hint },
          '默认 = 跟随部署默认模型。换模型会把思考强度重置为「跟随模型默认」。'))

      const effortField = () => h('div', { key: 'reasoningEffort', style: fieldStyle },
        h('span', { style: styles.label }, '思考强度'),
        h(Picker, {
          value: effortLabel,
          disabled: disabled || entry?.reasoning === undefined,
          options: effortOptions(entry, draft.reasoningEffort),
          onSelect: (patch) => setDraft({ ...draft, ...patch }),
        }),
        h('small', { style: styles.hint }, entry === undefined
          ? '先选择模型，再设置思考强度。'
          : entry.reasoning === undefined ? '该模型未提供可调的思考强度。' : '默认 = 跟随模型默认强度。'))

      const catalogNote = catalogState.status === 'error'
        ? h('div', { key: 'catalog-note', style: fieldStyle },
          h('p', { style: styles.warn }, `模型目录读取失败：${catalogState.error}。可手填下方字段，或点重试。`),
          h('button', {
            type: 'button',
            disabled,
            style: { ...styles.button, alignSelf: 'flex-start' },
            onClick: () => {
              loadCatalog({ force: true })
            },
          }, '重新读取模型目录'))
        : h('p', { key: 'catalog-note', style: styles.note }, '正在读取模型目录…（可先手填）')

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

      const [, permissionLabel, permissionHint] = fieldByName.get('permissionPreset')

      return h('form', { onSubmit: submit, style: styles.form },
        showHeading ? h('h3', { style: styles.title }, 'agent 任务会话') : null,
        h('p', { style: styles.note }, '保存后下一次任务执行即生效：模型 / 思考强度 / 权限档原地生效；只有 cwd、preset 或改回「跟随部署默认」会重建会话。任务模型不会改动部署默认模型。留空 = 使用下方标注的默认值。'),
        textField('cwd'),
        textField('agentPreset'),
        catalogReady ? modelField() : catalogNote,
        catalogReady ? null : textField('provider'),
        catalogReady ? null : textField('model'),
        catalogReady ? effortField() : textField('reasoningEffort'),
        warnings.length === 0
          ? null
          : h('div', { key: 'warnings', style: fieldStyle },
            ...warnings.map((warning, index) => h('p', { key: `warning:${index}`, style: styles.warn }, warning))),
        h('label', { key: 'permissionPreset', style: fieldStyle },
          h('span', { style: styles.label }, permissionLabel),
          h('select', {
            value: draft.permissionPreset ?? '',
            disabled,
            style: inputStyle,
            onChange: (event) => setDraft({ ...draft, permissionPreset: event.target.value }),
          }, ...PERMISSION_OPTIONS.map(([value, text]) => h('option', { key: value, value }, text))),
          h('small', { style: styles.hint }, permissionHint)),
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
      inject: ['slots', 'remote', 'remote.session'],
      apply(ctx) {
        clientCtx = ctx
        followCatalogEvents(ctx)
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
      /** Test seam: the pure catalog helpers, exercised by test/client.test.js. */
      internals: Object.freeze({
        FIELDS,
        fetchCatalog,
        normalizeCatalog,
        modelEntry,
        effortEntry,
        effortName,
        modelOptions,
        effortOptions,
        optionStyle,
      }),
    }
  },
})