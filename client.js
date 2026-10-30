/**
 * client.js — dsh-myops Desktop settings page (browser half).
 *
 * Registers one Settings section: `myops 工具`. It edits the persisted settings
 * file served by the host half (`/api/myops-settings`):
 *   - maxOutputChars : model-visible output cap for ops_bash/read/glob/grep/git
 *   - bashTimeoutMs  : default ops_bash timeout when `timeoutMs` is omitted
 *   - hideOfficial   : official pwsh/read/glob/grep hidden by the plugin (needs restart)
 *
 * Hand-written bundle in the DSH client-plugin module format — no build step.
 * Dependencies are the baseline shared modules (`react`); the section slot is
 * provided by the settings UI plugin declared in package.json's `dsh.client`
 * inject list.
 */
window.__ModuleLoader__.load({
  id: 'dsh-myops',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;
    const CFG = { prefix: '/api/myops-settings', label: 'myops 工具' };
    const HIDEABLE = [
      ['pwsh', 'pwsh（PowerShell 执行）'],
      ['read', 'read（官方读文件）'],
      ['glob', 'glob（官方文件查找）'],
      ['grep', 'grep（官方内容搜索）'],
    ];
    const labelStyle = { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', margin: 0 };
    const mutedStyle = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', margin: 0 };
    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: 14,
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-base)',
    };
    const fieldStyle = {
      font: 'inherit',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 8,
      padding: '8px 10px',
      width: '100%',
      boxSizing: 'border-box',
    };
    const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' };
    const btnStyle = { font: 'inherit', padding: '7px 14px', borderRadius: 8, cursor: 'pointer' };

    function createTransport(globals = globalThis) {
      const carrier = globals.__DSH_TRANSPORT__;
      const location = globals.location;
      const supported = location && ['http:', 'https:', 'dsh-app:', 'dsh:'].includes(location.protocol);
      const fetcher = typeof carrier?.fetch === 'function'
        ? carrier.fetch.bind(carrier)
        : supported && typeof globals.fetch === 'function'
          ? globals.fetch.bind(globals)
          : null;
      async function request(path, init) {
        if (!fetcher) throw new Error('当前页面没有可用的本机设置通信接口，请更新 DSH 桌面端后重开。');
        const response = await fetcher(CFG.prefix + path, { credentials: 'same-origin', cache: 'no-store', ...init });
        let body;
        try { body = await response.json(); } catch { throw new Error(`设置接口未返回 JSON（HTTP ${response.status}）。`); }
        if (!response.ok) throw new Error(body?.error || `设置接口失败（HTTP ${response.status}）。`);
        return body;
      }
      return {
        state: () => request('/state'),
        save: (patch) => request('/configure', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }),
      };
    }

    function Page() {
      const api = useMemo(() => createTransport(globalThis), []);
      const [state, setState] = useState(null);
      const [draft, setDraft] = useState({ maxOutputChars: '', bashTimeoutMs: '', hideOfficial: [] });
      const [status, setStatus] = useState({ kind: 'loading', message: '正在读取设置…' });
      const [saving, setSaving] = useState(false);
      const [initialHide, setInitialHide] = useState('[]');

      async function refresh() {
        try {
          const next = await api.state();
          setState(next);
          setInitialHide(JSON.stringify(next.settings.hideOfficial));
          setDraft({
            maxOutputChars: String(next.settings.maxOutputChars),
            bashTimeoutMs: String(next.settings.bashTimeoutMs),
            hideOfficial: next.settings.hideOfficial,
          });
          setStatus({ kind: 'idle', message: '' });
        } catch (error) {
          setStatus({ kind: 'error', message: String(error?.message ?? error) });
        }
      }
      useEffect(() => { void refresh(); }, []);

      function toggleTool(name, checked) {
        setDraft((value) => ({
          ...value,
          hideOfficial: checked
            ? [...new Set([...value.hideOfficial, name])]
            : value.hideOfficial.filter((item) => item !== name),
        }));
      }

      async function save() {
        const maxOutputChars = Number(draft.maxOutputChars);
        const bashTimeoutMs = Number(draft.bashTimeoutMs);
        if (!Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1_000 || maxOutputChars > 2_000_000) {
          setStatus({ kind: 'error', message: '输出上限需为 1,000 – 2,000,000 的整数。' });
          return;
        }
        if (!Number.isSafeInteger(bashTimeoutMs) || bashTimeoutMs < 1_000 || bashTimeoutMs > 2_147_483_647) {
          setStatus({ kind: 'error', message: '默认超时需为 1,000 – 2,147,483,647 毫秒的整数。' });
          return;
        }
        setSaving(true);
        setStatus({ kind: 'saving', message: '正在保存…' });
        try {
          const saved = await api.save({ maxOutputChars, bashTimeoutMs, hideOfficial: draft.hideOfficial });
          setState((value) => ({ ...value, settings: saved.settings }));
          setDraft({
            maxOutputChars: String(saved.settings.maxOutputChars),
            bashTimeoutMs: String(saved.settings.bashTimeoutMs),
            hideOfficial: saved.settings.hideOfficial,
          });
          const hideChanged = JSON.stringify(saved.settings.hideOfficial) !== initialHide;
          setInitialHide(JSON.stringify(saved.settings.hideOfficial));
          setStatus({
            kind: 'saved',
            message: hideChanged
              ? '已保存。输出上限与默认超时立即生效；官方工具屏蔽需重启 DSH 桌面端后生效。'
              : '已保存并生效。',
          });
        } catch (error) {
          setStatus({ kind: 'error', message: String(error?.message ?? error) });
        } finally {
          setSaving(false);
        }
      }

      const tools = Array.isArray(state?.tools) ? state.tools : [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820, paddingBottom: 32 } },
        h('h2', { style: { margin: 0 } }, 'dsh-myops 工具设置'),
        h('p', { style: mutedStyle }, state ? `版本 ${state.version} · ${state.platform} · 已注册 ${tools.length} 个工具` : '正在读取插件状态…'),
        status.kind === 'error' && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-label-error, #c0392b)', margin: 0 } }, status.message),
        status.kind === 'saved' && h('p', { role: 'status', style: { color: 'var(--dsw-alias-label-success, #1e7e34)', margin: 0 } }, status.message),
        h('div', { style: cardStyle },
          h('label', { style: { ...labelStyle, fontWeight: 600 } }, '模型可见输出上限（字符）'),
          h('input', {
            type: 'number', min: 1000, max: 2000000, step: 1000, style: fieldStyle,
            'aria-label': '模型可见输出上限（字符）',
            value: draft.maxOutputChars,
            disabled: saving,
            onChange: (event) => setDraft({ ...draft, maxOutputChars: event.target.value }),
          }),
          h('p', { style: mutedStyle }, '超过上限的输出会落盘，模型只收到预览，可用 ops_result 翻页。默认 60000。'),
        ),
        h('div', { style: cardStyle },
          h('label', { style: { ...labelStyle, fontWeight: 600 } }, 'ops_bash 默认超时（毫秒）'),
          h('input', {
            type: 'number', min: 1000, max: 2147483647, step: 1000, style: fieldStyle,
            'aria-label': 'ops_bash 默认超时（毫秒）',
            value: draft.bashTimeoutMs,
            disabled: saving,
            onChange: (event) => setDraft({ ...draft, bashTimeoutMs: event.target.value }),
          }),
          h('p', { style: mutedStyle }, '调用时显式传 timeoutMs 仍优先。默认 120000（2 分钟）。'),
        ),
        h('div', { style: cardStyle },
          h('span', { style: { ...labelStyle, fontWeight: 600 } }, '屏蔽官方工具（hideOfficial）'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            ...HIDEABLE.map(([name, text]) => h('label', { key: name, style: rowStyle },
              h('input', {
                type: 'checkbox',
                checked: draft.hideOfficial.includes(name),
                disabled: saving,
                'aria-label': `屏蔽官方工具 ${name}`,
                onChange: (event) => toggleTool(name, event.target.checked),
              }),
              h('span', { style: labelStyle }, text),
            )),
          ),
          h('p', { style: mutedStyle }, '屏蔽后该官方工具从工具面移除并拒绝执行，改用 ops_* 替代。修改需重启 DSH 桌面端生效。'),
        ),
        h('div', { style: rowStyle },
          h('button', { type: 'button', style: btnStyle, disabled: saving || status.kind === 'loading', onClick: () => { void save(); } }, saving ? '保存中…' : '保存设置'),
          h('button', { type: 'button', style: btnStyle, disabled: saving, onClick: () => { void refresh(); } }, '重新读取'),
        ),
        state?.settingsPath && h('p', { style: mutedStyle }, `设置文件：${state.settingsPath}`),
        tools.length > 0 && h('p', { style: mutedStyle }, `已注册工具：${tools.join(', ')}`),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'myops',
        order: 18,
        label: () => CFG.label,
      }, Page));
    }

    return { name: 'myops-settings', inject: ['slots'], apply, SettingsPage: Page, createTransport };
  },
});
