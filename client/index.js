/**
 * SciX literature plugin — Client half (dev brief §5–6; contracts/ui.js + contracts/token.js).
 *
 * Plain hand-written browser bundle: no build step, no runtime imports of Harness
 * Client packages. React comes from the browser module table. The factory id MUST
 * equal the package name ('scix-dsh-plugin').
 *
 * Wiring (verified against installed 0.2.2-rc.5 sources):
 * - Settings form registers into the keyed slot 'plugins.bundle.config' under key
 *   'scix-dsh-plugin' (dsh-client-ui-plugin-manager/src/client/slot-contract.ts);
 *   owner props are { view, form }; the registration's `locale` option supplies `t`
 *   (dsh-client-ui-renderer/src/client/scoped-slots.tsx localeSeat).
 * - UI strings register through ctx.locale.register(ns, { zh, en })
 *   (dsh-client-locale). The SAME strings live in locale/zh.json / locale/en.json
 *   under "ui" for translators; a gate keeps the two copies identical. The locale
 *   JSON files' "meta" section is display metadata read by the Host plugin manager.
 * - Token storage is CREDENTIALS, never config: the existing Client-callable Host
 *   namespace ctx.remote.credentials.set/describe/unset (Host owner
 *   credentialsController; dsh-api-settings-controller/src/credentials.ts).
 *   Ref shape: the bare string 'SCIX_API_TOKEN' (TOKEN_CREDENTIAL_REF).
 * - Verify calls the Host endpoint REMOTE_NAMESPACE + '/' + REMOTE_VERIFY_METHOD
 *   ('scix/verifyToken', service 'scixController') through the Connection RPC:
 *     ctx.connection.rpc.call('/api', 'scix/verifyToken', { args: {} })
 *   This is the exact call the generated Client Remote makes internally
 *   (dsh-api-gateway/src/client/index.ts invoke(); caller signature and envelope
 *   in dsh-client-connection/src/client/rpc.ts). Mechanism agreed with host-core:
 *   client remote namespaces are not auto-discovered from the Host (installed
 *   dsh/docs/api-gateway.md), and this plain-ESM bundle ships no generated
 *   contribution, so the raw /api RPC is the supported path. The Host core
 *   exposes the endpoint via the Gateway SRC marker on service 'scixController'
 *   (src/core/token.js registerVerifyRemote).
 * - The RPC resolves { ok: true, value } | { ok: false, error: { code, message, details } }
 *   and THROWS on transport failures (HTTP error, abort); the Verify handler
 *   covers both. Business result: TokenVerification { ok, message, status? }.
 * - Styles use host theme tokens (--dsw-alias-*, --dsw-radius-*, --dsw-focus-ring-*);
 *   no hardcoded light/dark colors. The <style> element renders inside the component
 *   so unmounting removes it.
 */
window.__ModuleLoader__.load({
  id: 'scix-dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ---- Contract constants (mirror src/contracts/ui.js + src/contracts/token.js;
    // ---- the browser cannot import Host src). Keep in sync with those files. ----
    const PACKAGE_NAME = 'scix-dsh-plugin';
    const SLOT_BUNDLE_CONFIG = 'plugins.bundle.config';
    const BUNDLE_CONFIG_KEY = PACKAGE_NAME;
    const TOKEN_CREDENTIAL_REF = 'SCIX_API_TOKEN';
    // Host-side service key (dispatch target of the endpoint; kept for contract parity).
    const REMOTE_SERVICE_NAME = 'scixController';
    const REMOTE_NAMESPACE = 'scix';
    const REMOTE_VERIFY_METHOD = 'verifyToken';
    const LOCALE_NS = 'scix';
    const TOKEN_PAGE_URL = 'https://ui.adsabs.harvard.edu/#user/settings/token';

    // ---- UI dictionaries. MUST stay identical to the "ui" section of
    // ---- locale/zh.json and locale/en.json (checked by the task gate).
    // ---- Quoted keys + string values only: this literal is valid JSON. ----
    const UI_STRINGS = {
      "zh": {
        "sectionLabel": "SciX API Token 设置",
        "tokenLabel": "API Token",
        "tokenHint": "在 ADS/SciX 个人设置页生成免费 Token 后填入此处。Token 仅保存在本机凭据存储中,不会写入插件配置,保存后不再显示原文。",
        "tokenPage": "获取 ADS Token",
        "tokenPlaceholder": "粘贴你的 ADS/SciX API Token",
        "save": "保存",
        "saving": "保存中…",
        "verify": "验证",
        "verifying": "验证中…",
        "remove": "移除",
        "removing": "移除中…",
        "saved": "Token 已保存。",
        "removed": "Token 已移除。",
        "tokenStored": "已存储 Token",
        "tokenAbsent": "尚未存储 Token",
        "tokenSource": "(来源:{source})",
        "notWritable": "当前凭据来源不可写,无法在此保存或移除。",
        "errEmpty": "请先输入非空 Token。",
        "saveFailed": "保存失败:{message}",
        "removeFailed": "移除失败:{message}",
        "describeFailed": "无法读取凭据状态:{message}",
        "verifyUnavailable": "验证服务不可用:请确认插件已启用且 Host 核心已加载。",
        "verifyFailed": "验证调用失败:{message}",
        "verifyOk": "Token 有效。",
        "verifyBad": "Token 验证未通过。",
        "loading": "正在读取凭据状态…"
      },
      "en": {
        "sectionLabel": "SciX API token settings",
        "tokenLabel": "API token",
        "tokenHint": "Create a free personal token on the ADS/SciX settings page and paste it here. The token is stored only in the local credential store, never in plugin config, and is never shown again after saving.",
        "tokenPage": "Get an ADS token",
        "tokenPlaceholder": "Paste your ADS/SciX API token",
        "save": "Save",
        "saving": "Saving…",
        "verify": "Verify",
        "verifying": "Verifying…",
        "remove": "Remove",
        "removing": "Removing…",
        "saved": "Token saved.",
        "removed": "Token removed.",
        "tokenStored": "A token is stored",
        "tokenAbsent": "No token stored",
        "tokenSource": "(source: {source})",
        "notWritable": "The current credential source is read-only; saving and removing are unavailable here.",
        "errEmpty": "Enter a non-empty token first.",
        "saveFailed": "Save failed: {message}",
        "removeFailed": "Remove failed: {message}",
        "describeFailed": "Could not read credential status: {message}",
        "verifyUnavailable": "Verify service unavailable: make sure the plugin is enabled and its Host core is loaded.",
        "verifyFailed": "Verify call failed: {message}",
        "verifyOk": "The token is valid.",
        "verifyBad": "The token did not verify.",
        "loading": "Reading credential status…"
      }
    };

    // ---- Verify endpoint: '<namespace>/<method>' on the '/api' RPC channel.
    // ---- Zero business arguments: the Gateway requires args to be exactly {}. ----
    const VERIFY_ENDPOINT = REMOTE_NAMESPACE + '/' + REMOTE_VERIFY_METHOD;

    // ---- Component-local styles: host theme tokens only, unique class prefix. ----
    const CSS = [
      '.scix-cfg{display:flex;flex-direction:column;gap:10px;padding:4px 0;color:var(--dsw-alias-label-primary);font-size:13px;}',
      '.scix-cfg-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.scix-cfg-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      '.scix-cfg-link{color:var(--dsw-alias-link);text-decoration:none;}',
      '.scix-cfg-link:hover{text-decoration:underline;}',
      '.scix-cfg-input{box-sizing:border-box;width:100%;max-width:420px;height:40px;padding:0 14px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);outline:none;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);}',
      '.scix-cfg-input:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-state-business-primary);}',
      '.scix-cfg-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}',
      '.scix-cfg-actions{display:flex;flex-wrap:wrap;gap:8px;}',
      '.scix-cfg-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}',
      '.scix-cfg-btn:disabled{opacity:0.4;cursor:default;}',
      '.scix-cfg-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}',
      '.scix-cfg-save{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.scix-cfg-verify{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);}',
      '.scix-cfg-remove{background:transparent;color:var(--dsw-alias-state-error-primary);}',
      '@media (hover:hover){.scix-cfg-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}.scix-cfg-verify:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}.scix-cfg-remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,var(--dsw-alias-interactive-bg-hover));}}',
      '.scix-cfg-status{margin:0;min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}',
      ".scix-cfg-status[data-kind='success']{color:var(--dsw-alias-state-success-primary);}",
      ".scix-cfg-status[data-kind='error']{color:var(--dsw-alias-state-error-primary);}",
      '.scix-cfg-stored{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
    ].join('\n');

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    return {
      // 'connection' carries the /api RPC used by Verify; 'remote.credentials'
      // is the existing generated namespace used by Save/Remove/status.
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'connection'],
      apply(ctx) {
        // UI dictionaries (zh primary, en baseline); disposer unregisters them.
        ctx.effect(() => ctx.locale.register(LOCALE_NS, UI_STRINGS), 'scix: ui dictionaries');

        // The settings component closes over ctx for remote calls.
        function ScixSettings({ t, view }) {
          const [token, setToken] = React.useState('');
          const [busy, setBusy] = React.useState(null); // 'save' | 'verify' | 'remove' | null
          const [status, setStatus] = React.useState(null); // { kind, text } | null
          const [info, setInfo] = React.useState(undefined); // CredentialInfo | undefined
          const [loading, setLoading] = React.useState(true);
          const live = React.useRef(true);
          const inputId = React.useId();
          const hintId = React.useId();

          // describe() shows WHETHER a token is stored; no read path returns the value.
          async function refresh() {
            try {
              const result = await ctx.remote.credentials.describe([TOKEN_CREDENTIAL_REF]);
              if (!live.current) return;
              if (result.ok) {
                setInfo(result.value[TOKEN_CREDENTIAL_REF]);
              } else {
                setInfo(undefined);
                setStatus({ kind: 'error', text: t('describeFailed', { message: result.error.message }) });
              }
            } catch (error) {
              if (!live.current) return;
              setInfo(undefined);
              setStatus({ kind: 'error', text: t('describeFailed', { message: errorMessage(error) }) });
            } finally {
              if (live.current) setLoading(false);
            }
          }

          React.useEffect(() => {
            live.current = true;
            void refresh();
            return () => { live.current = false; };
          }, []);

          async function save() {
            const value = token.trim();
            if (value === '') {
              setStatus({ kind: 'error', text: t('errEmpty') });
              return;
            }
            setBusy('save');
            setStatus(null);
            try {
              const result = await ctx.remote.credentials.set(TOKEN_CREDENTIAL_REF, value);
              if (!live.current) return;
              if (result.ok) {
                setToken('');
                setStatus({ kind: 'success', text: t('saved') });
                await refresh();
              } else {
                setStatus({ kind: 'error', text: t('saveFailed', { message: result.error.message }) });
              }
            } catch (error) {
              if (live.current) setStatus({ kind: 'error', text: t('saveFailed', { message: errorMessage(error) }) });
            } finally {
              if (live.current) setBusy(null);
            }
          }

          async function verify() {
            setBusy('verify');
            setStatus(null);
            try {
              const connection = ctx.connection;
              if (connection === undefined || connection.rpc === undefined) {
                setStatus({ kind: 'error', text: t('verifyUnavailable') });
                return;
              }
              // Same call the generated Client Remote makes internally; the Host
              // Gateway dispatches 'scix/verifyToken' to scixController.verifyToken().
              const result = await connection.rpc.call('/api', VERIFY_ENDPOINT, { args: {} });
              if (!live.current) return;
              if (!result.ok) {
                setStatus({ kind: 'error', text: t('verifyFailed', { message: result.error.message }) });
                return;
              }
              const verdict = result.value || {};
              const text = typeof verdict.message === 'string' && verdict.message !== ''
                ? verdict.message
                : (verdict.ok ? t('verifyOk') : t('verifyBad'));
              setStatus({ kind: verdict.ok ? 'success' : 'error', text });
            } catch (error) {
              // rpc.call throws on transport failures (HTTP error, abort).
              if (live.current) setStatus({ kind: 'error', text: t('verifyFailed', { message: errorMessage(error) }) });
            } finally {
              if (live.current) setBusy(null);
            }
          }

          async function remove() {
            setBusy('remove');
            setStatus(null);
            try {
              const result = await ctx.remote.credentials.unset(TOKEN_CREDENTIAL_REF);
              if (!live.current) return;
              if (result.ok) {
                setStatus({ kind: 'success', text: t('removed') });
                await refresh();
              } else {
                setStatus({ kind: 'error', text: t('removeFailed', { message: result.error.message }) });
              }
            } catch (error) {
              if (live.current) setStatus({ kind: 'error', text: t('removeFailed', { message: errorMessage(error) }) });
            } finally {
              if (live.current) setBusy(null);
            }
          }

          // Bundle configuration renders only the page view (slot contract).
          if (view !== 'page') return null;

          const writable = info === undefined || info.writable !== false;
          const configured = info !== undefined && info.configured === true;
          const storedText = loading
            ? t('loading')
            : (configured ? t('tokenStored') : t('tokenAbsent'))
              + (info !== undefined && typeof info.source === 'string' && info.source !== ''
                ? ' ' + t('tokenSource', { source: info.source })
                : '');

          return h('section', {
            className: 'scix-cfg',
            'aria-label': t('sectionLabel'),
            'aria-busy': busy !== null || undefined,
          },
            h('style', null, CSS),
            h('label', { className: 'scix-cfg-label', htmlFor: inputId }, t('tokenLabel')),
            h('p', { className: 'scix-cfg-hint', id: hintId },
              t('tokenHint'), ' ',
              h('a', {
                className: 'scix-cfg-link',
                href: TOKEN_PAGE_URL,
                target: '_blank',
                rel: 'noreferrer',
              }, t('tokenPage'))),
            h('input', {
              id: inputId,
              className: 'scix-cfg-input',
              type: 'password',
              value: token,
              placeholder: t('tokenPlaceholder'),
              autoComplete: 'off',
              spellCheck: false,
              'aria-describedby': hintId,
              disabled: busy !== null,
              onChange: (event) => setToken(event.target.value),
            }),
            h('div', { className: 'scix-cfg-actions' },
              h('button', {
                type: 'button',
                className: 'scix-cfg-btn scix-cfg-save',
                disabled: busy !== null || token.trim() === '' || !writable,
                onClick: () => { void save(); },
              }, busy === 'save' ? t('saving') : t('save')),
              h('button', {
                type: 'button',
                className: 'scix-cfg-btn scix-cfg-verify',
                disabled: busy !== null,
                onClick: () => { void verify(); },
              }, busy === 'verify' ? t('verifying') : t('verify')),
              h('button', {
                type: 'button',
                className: 'scix-cfg-btn scix-cfg-remove',
                disabled: busy !== null || !configured || !writable,
                onClick: () => { void remove(); },
              }, busy === 'remove' ? t('removing') : t('remove'))),
            !writable ? h('p', { className: 'scix-cfg-stored' }, t('notWritable')) : null,
            h('p', { className: 'scix-cfg-stored' }, storedText),
            h('p', {
              className: 'scix-cfg-status',
              role: 'status',
              'aria-live': 'polite',
              'data-kind': status ? status.kind : undefined,
            }, status ? status.text : ''));
        }

        ctx.slots.inject(SLOT_BUNDLE_CONFIG, () => ctx.slots.register({
          name: SLOT_BUNDLE_CONFIG,
          key: BUNDLE_CONFIG_KEY,
          locale: LOCALE_NS,
        }, ScixSettings));
      },
    };
  },
});
