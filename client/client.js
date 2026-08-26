// Browser half of the dsh-plugin-git-sync: a configuration card in the
// Plugins settings section (设置 → 插件 → 插件配置), bound to the "git-sync"
// settings namespace. Hand-written in the lazy-CJS bundle protocol
// (window.__ModuleLoader__.load with a factory returning cordis-plugin
// exports), so no build step is required.
//
// The card reads/writes the "git-sync" namespace through the shared settings
// mirror; nested fields (github.username, safety.maxFileSizeMb, ...) are
// written with path ops via the settings wire face. The GitHub token is a
// write-only control addressed by the GITHUB_TOKEN credential reference.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-git-sync',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var jsx = require('react/jsx-runtime');
    var runtimeClient = require('@deepseek-ai/dsh-client-runtime/client');

    // Locale namespace of this browser half.
    var NS = 'dsh-plugin-git-sync';
    // Settings namespace this card edits (matches the host registration).
    var SETTINGS_NS = 'git-sync';
    // Credential reference the token control addresses (matches host token.ts).
    var TOKEN_REF = 'GITHUB_TOKEN';

    // ---- styles ----
    (function injectStyles() {
      var tagId = 'dsh-plugin-git-sync/card.css';
      // JSON.stringify emits the quoted value, so the attribute selector is
      // `style[data-plugin-css="..."]` — do NOT wrap it in extra quotes.
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')) return;
      var css = [
        '.gs-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
        '.gs-header{width:100%;display:flex;align-items:center;gap:10px;padding:12px 14px;background:none;border:none;cursor:pointer;text-align:left;font:inherit;color:var(--dsw-alias-label-primary)}',
        '.gs-headText{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.gs-name{font-size:14px;font-weight:600}',
        '.gs-desc{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
        '.gs-pending{font-size:11px;color:var(--dsw-alias-label-warning,#d99a1f);white-space:nowrap}',
        '.gs-body{padding:2px 14px 12px;border-top:1px solid var(--dsw-alias-border-l2)}',
        '.gs-readonly{color:var(--dsw-alias-label-tertiary);font-size:12px}',
        '.gs-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
        '.gs-field+.gs-field{border-top:1px solid var(--dsw-alias-border-l2)}',
        '.gs-head{display:flex;align-items:center;gap:8px}',
        '.gs-label{flex:1;min-width:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
        '.gs-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px}',
        '.gs-badgeMuted{white-space:nowrap;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-size:11px}',
        '.gs-reset{font:inherit;color:var(--dsw-alias-label-secondary);background:none;border:none;cursor:pointer;padding:0;font-size:12px}',
        '.gs-input,.gs-select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px}',
        '.gs-input:focus-visible,.gs-select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
        '.gs-inputInvalid{border-color:var(--dsw-alias-label-error)}',
        '.gs-hint,.gs-invalid{margin:0;font-size:12px;line-height:1.5}',
        '.gs-hint{color:var(--dsw-alias-label-tertiary)}',
        '.gs-invalid{color:var(--dsw-alias-label-error)}',
        '.gs-footer{display:flex;justify-content:flex-end;gap:8px;padding-top:10px}',
        '.gs-save{background:var(--dsw-alias-brand-primary);color:#fff;border:none;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}',
        '.gs-save:disabled{opacity:.5;cursor:default}',
        '.gs-discard{background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.gs-discard:disabled{opacity:.5;cursor:default}',
        '.gs-failed{color:var(--dsw-alias-label-error);font-size:12px;margin:0 0 8px}',
        '.gs-chevron{width:12px;height:12px;flex:none;border-right:2px solid var(--dsw-alias-label-secondary);border-bottom:2px solid var(--dsw-alias-label-secondary);transform:rotate(45deg);transition:transform .18s ease;opacity:.7}',
        '.gs-chevronOpen{transform:rotate(225deg)}'
      ].join('');
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-plugin-git-sync';
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    })();

    // ---- field specs ----
    function textField(id, path) {
      return {
        id: id,
        path: path,
        kind: 'text',
        format: function (value) { return value === void 0 || value === null ? '' : String(value); },
        parse: function (text) { return { kind: 'set', value: text }; }
      };
    }
    function numberField(id, path) {
      return {
        id: id,
        path: path,
        kind: 'number',
        format: function (value) { return typeof value === 'number' ? String(value) : ''; },
        parse: function (text) {
          var trimmed = text.trim();
          if (trimmed === '') return { kind: 'clear' };
          var parsed = Number(trimmed);
          return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : void 0;
        }
      };
    }
    // choice: options is an array of { value, labelKey } — labels come from locale.
    function choiceField(id, path, options) {
      return {
        id: id,
        path: path,
        kind: 'choice',
        options: options,
        format: function (value) { return value === void 0 || value === null ? '' : String(value); },
        parse: function (text) {
          if (text === '') return { kind: 'clear' };
          for (var i = 0; i < options.length; i++) {
            if (String(options[i].value) === text) return { kind: 'set', value: options[i].value };
          }
          return void 0;
        }
      };
    }

    // ---- path helpers ----
    function getPath(root, path) {
      var node = root;
      for (var i = 0; i < path.length; i++) {
        if (node === void 0 || node === null) return void 0;
        node = node[path[i]];
      }
      return node;
    }
    function hasPath(root, path) {
      var node = root;
      for (var i = 0; i < path.length; i++) {
        if (node === void 0 || node === null || typeof node !== 'object') return false;
        if (!Object.prototype.hasOwnProperty.call(node, path[i])) return false;
        node = node[path[i]];
      }
      return true;
    }

    // ---- form model (path-aware CardForm) ----
    var CardForm = (function () {
      function CardForm(scope, describeFace, api, specs, secrets) {
        this.scope = scope;
        this.describeFace = describeFace;
        this.api = api;
        this.specs = new Map(specs.map(function (spec) { return [spec.id, spec]; }));
        this.secretSpecs = new Map(secrets.map(function (spec) { return [spec.id, spec]; }));
        this.staged = new Map();
        this.listeners = new Set();
        this.saving = false;
        this.failed = false;
        scope.subscribe(function () { this.publish(); }.bind(this));
      }
      CardForm.prototype.bind = function (project) {
        var store = runtimeClient.createSnapshotStore(project());
        this.listeners.add(function () { store.set(project()); });
        return store;
      };
      CardForm.prototype.shell = function () {
        var snapshot = this.scope.getSnapshot();
        var plan = this.plan();
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable,
          dirty: plan.length > 0,
          invalid: plan.some(function (item) { return item.run === void 0; }),
          saving: this.saving,
          failed: this.failed
        };
      };
      CardForm.prototype.field = function (id) {
        var staged = this.staged.get(id);
        if (this.secretSpecs.has(id)) {
          return { text: staged ? staged.text : '', overridden: false, invalid: false };
        }
        var spec = this.specs.get(id);
        if (staged === void 0) {
          return {
            text: spec.format(this.sectionValue(id)),
            overridden: this.stored(id),
            invalid: false,
            options: spec.options
          };
        }
        var write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text);
        return {
          text: staged.text,
          overridden: write && write.kind === 'set',
          invalid: write === void 0,
          options: spec.options
        };
      };
      CardForm.prototype.actions = function () {
        var self = this;
        return {
          edit: function (id, text) { self.stage(id, { text: text, clear: false }); },
          resetField: function (id) {
            var spec = self.specs.get(id);
            self.stage(id, { text: spec.format(self.baseValue(id)), clear: true });
          },
          save: function () { self.save(); },
          discard: function () {
            if (self.staged.size === 0 && !self.failed) return;
            self.staged.clear();
            self.failed = false;
            self.publish();
          }
        };
      };
      CardForm.prototype.save = function () {
        var self = this;
        var plan = this.plan();
        var writes = plan.filter(function (item) { return item.run !== void 0; }).map(function (item) { return item.run; });
        if (plan.length === 0 || this.saving || writes.length !== plan.length) return;
        this.saving = true;
        this.failed = false;
        this.publish();
        var task = Promise.resolve();
        for (var i = 0; i < writes.length; i++) {
          (function (write) {
            task = task.then(function () { return write(); }).then(function (landed) {
              if (!landed) throw new Error('settings write failed');
            });
          })(writes[i]);
        }
        task.then(function () {
          self.staged.clear();
          self.saving = false;
          self.failed = false;
          if (self.describeFace && typeof self.describeFace.load === 'function') {
            self.describeFace.load().catch(function () {});
          }
          self.publish();
        }, function () {
          self.saving = false;
          self.failed = true;
          self.publish();
        });
      };
      CardForm.prototype.plan = function () {
        var self = this;
        var plan = [];
        var entries = Array.from(this.staged.entries());
        for (var i = 0; i < entries.length; i++) {
          var id = entries[i][0];
          var staged = entries[i][1];
          var secret = this.secretSpecs.get(id);
          if (secret !== void 0) {
            var value = staged.text.trim();
            if (value !== '') {
              (function (v) {
                plan.push({ run: function () { return secret.write(v); } });
              })(value);
            }
            continue;
          }
          var spec = this.specs.get(id);
          if (staged.clear) {
            if (this.stored(id)) {
              (function (fid) {
                plan.push({ run: function () { return self.clear(fid); } });
              })(id);
            }
            continue;
          }
          if (staged.text === spec.format(this.sectionValue(id))) continue;
          var write = spec.parse(staged.text);
          if (write === void 0) plan.push({ run: void 0 });
          else if (write.kind === 'clear') {
            (function (fid) {
              plan.push({ run: function () { return self.clear(fid); } });
            })(id);
          } else {
            (function (fid, val) {
              plan.push({ run: function () { return self.store(fid, val); } });
            })(id, write.value);
          }
        }
        return plan;
      };
      CardForm.prototype.clear = function (id) {
        var self = this;
        return this.mutate({ op: 'unset', path: this.specs.get(id).path }).then(function (ok) {
          return ok && !self.stored(id);
        });
      };
      CardForm.prototype.store = function (id, value) {
        var self = this;
        return this.mutate({ op: 'set', path: this.specs.get(id).path, value: value }).then(function (ok) {
          return ok && self.userAt(id) === value;
        });
      };
      CardForm.prototype.mutate = function (op) {
        var snapshot = this.scope.getSnapshot();
        return this.api.settings.mutate({
          ns: SETTINGS_NS,
          ops: [op],
          ...(snapshot.revision !== void 0 ? { expectedRevision: snapshot.revision } : {})
        }).then(function (response) {
          return !!(response && response.result && response.result.ok);
        }).catch(function () { return false; });
      };
      CardForm.prototype.stage = function (id, edit) {
        this.staged.set(id, edit);
        this.failed = false;
        this.publish();
      };
      CardForm.prototype.snapshotOf = function () { return this.scope.getSnapshot(); };
      CardForm.prototype.sectionValue = function (id) { return getPath(this.snapshotOf().value, this.specs.get(id).path); };
      CardForm.prototype.baseValue = function (id) { return getPath(this.snapshotOf().base, this.specs.get(id).path); };
      CardForm.prototype.userAt = function (id) { return getPath(this.snapshotOf().user, this.specs.get(id).path); };
      CardForm.prototype.stored = function (id) {
        return hasPath(this.snapshotOf().user, this.specs.get(id).path);
      };
      CardForm.prototype.publish = function () {
        var listeners = Array.from(this.listeners);
        for (var i = 0; i < listeners.length; i++) listeners[i]();
      };
      return CardForm;
    })();

    // ---- credential helpers (write-only, value never rides a response) ----
    function describeCredential(api, ref) {
      return api.credentials.describe({ refs: [ref] }).then(function (response) {
        if (!response || !response.result || !response.result.ok) return { configured: false, writable: true };
        var view = response.result.value.credentials[ref];
        return { configured: !!(view && view.configured), writable: !(view && view.writable === false) };
      }).catch(function () { return { configured: false, writable: true }; });
    }

    // ---- controller ----
    var GitSyncCardController = (function () {
      function GitSyncCardController(scope, describeFace, api) {
        this.credential = { configured: false, writable: true };
        this.form = new CardForm(
          scope,
          describeFace,
          api,
          [
            textField('github.username', ['github', 'username']),
            choiceField('github.visibility', ['github', 'visibility'], [
              { value: 'private', labelKey: 'private' },
              { value: 'public', labelKey: 'public' }
            ]),
            textField('github.defaultBranch', ['github', 'defaultBranch']),
            choiceField('github.insecureTls', ['github', 'insecureTls'], [
              { value: true, labelKey: 'enabled' },
              { value: false, labelKey: 'disabled' }
            ]),
            choiceField('auth.method', ['auth', 'method'], [
              { value: 'extraheader', labelKey: 'extraheader' },
              { value: 'askpass', labelKey: 'askpass' }
            ]),
            textField('git.committerName', ['git', 'committerName']),
            textField('git.committerEmail', ['git', 'committerEmail']),
            choiceField('autoSync', ['autoSync'], [
              { value: true, labelKey: 'enabled' },
              { value: false, labelKey: 'disabled' },
              { value: 'ask', labelKey: 'ask' }
            ]),
            choiceField('askBeforeInit', ['askBeforeInit'], [
              { value: true, labelKey: 'enabled' },
              { value: false, labelKey: 'disabled' }
            ]),
            choiceField('init.createGitignore', ['init', 'createGitignore'], [
              { value: true, labelKey: 'enabled' },
              { value: false, labelKey: 'disabled' }
            ]),
            textField('init.initialCommitMessage', ['init', 'initialCommitMessage']),
            choiceField('safety.scanForSecrets', ['safety', 'scanForSecrets'], [
              { value: true, labelKey: 'enabled' },
              { value: false, labelKey: 'disabled' }
            ]),
            numberField('safety.maxFileSizeMb', ['safety', 'maxFileSizeMb'])
          ],
          [{
            id: 'token',
            write: function (text) { return this.writeToken(text); }.bind(this)
          }]
        );
        this.store = this.form.bind(function () { return this.projection(); }.bind(this));
        var self = this;
        scope.subscribe(function () { self.readCredential(); });
        this.readCredential();
      }
      GitSyncCardController.prototype.projection = function () {
        var fields = {};
        var ids = ['token', 'github.username', 'github.visibility', 'github.defaultBranch',
          'github.insecureTls', 'auth.method', 'git.committerName', 'git.committerEmail',
          'autoSync', 'askBeforeInit', 'init.createGitignore', 'init.initialCommitMessage',
          'safety.scanForSecrets', 'safety.maxFileSizeMb'];
        for (var i = 0; i < ids.length; i++) fields[ids[i]] = this.form.field(ids[i]);
        return {
          ...this.form.shell(),
          ...fields,
          tokenConfigured: this.credential.configured,
          tokenWritable: this.credential.writable
        };
      };
      GitSyncCardController.prototype.inject = function () {
        return {
          hooks: { gitSyncCard: this.store },
          ...this.form.actions()
        };
      };
      GitSyncCardController.prototype.readCredential = function () {
        var self = this;
        describeCredential(this.form.api, TOKEN_REF).then(function (next) {
          if (next.configured === self.credential.configured && next.writable === self.credential.writable) return;
          self.credential = next;
          self.store.set(self.projection());
        });
      };
      GitSyncCardController.prototype.refreshCredential = function (ref) {
        if (ref !== TOKEN_REF) return;
        this.readCredential();
      };
      GitSyncCardController.prototype.writeToken = function (value) {
        var self = this;
        return this.form.api.credentials.set({ ref: TOKEN_REF, value: value })
          .then(function () { self.readCredential(); return self.credential.configured; })
          .catch(function () { return false; });
      };
      return GitSyncCardController;
    })();

    // ---- controls ----
    function ValueField(props) {
      return jsx.jsxs('div', { className: 'gs-field', children: [
        jsx.jsxs('div', { className: 'gs-head', children: [
          jsx.jsx('label', { className: 'gs-label', htmlFor: props.id, children: props.label }),
          props.overridden ? jsx.jsx('span', { className: 'gs-badge', children: [
            props.overriddenLabel,
            jsx.jsx('button', { type: 'button', className: 'gs-reset', disabled: props.disabled, onClick: props.onReset, children: props.resetLabel })
          ] }) : null
        ] }),
        jsx.jsx('input', {
          id: props.id,
          className: props.invalid ? 'gs-input gs-inputInvalid' : 'gs-input',
          type: 'text',
          ...(props.numeric ? { inputMode: 'numeric' } : {}),
          ...(props.invalid ? { 'aria-invalid': true } : {}),
          value: props.text,
          placeholder: props.placeholder || '',
          disabled: props.disabled,
          onChange: function (event) { props.onEdit(event.target.value); }
        }),
        jsx.jsx('p', { className: props.invalid ? 'gs-invalid' : 'gs-hint',
          children: props.invalid ? (props.invalidLabel || '') : (props.hint || '') })
      ] });
    }

    // A select control for union/boolean fields; choices carry locale label keys.
    function ChoiceField(props) {
      var options = (props.field && props.field.options) || [];
      return jsx.jsxs('div', { className: 'gs-field', children: [
        jsx.jsxs('div', { className: 'gs-head', children: [
          jsx.jsx('label', { className: 'gs-label', htmlFor: props.id, children: props.label }),
          props.field && props.field.overridden ? jsx.jsx('span', { className: 'gs-badge', children: [
            props.overriddenLabel,
            jsx.jsx('button', { type: 'button', className: 'gs-reset', disabled: props.disabled, onClick: props.onReset, children: props.resetLabel })
          ] }) : null
        ] }),
        jsx.jsx('select', {
          id: props.id,
          className: 'gs-select',
          disabled: props.disabled,
          value: (props.field && props.field.text) || '',
          onChange: function (event) { props.onEdit(event.target.value); },
          children: options.map(function (option) {
            return jsx.jsx('option', { value: String(option.value), children: props.t(option.labelKey) },
              option.labelKey + ':' + String(option.value));
          })
        }),
        jsx.jsx('p', { className: 'gs-hint', children: props.hint || '' })
      ] });
    }

    function SecretField(props) {
      return jsx.jsxs('div', { className: 'gs-field', children: [
        jsx.jsxs('div', { className: 'gs-head', children: [
          jsx.jsx('label', { className: 'gs-label', htmlFor: props.id, children: props.label }),
          jsx.jsx('span', { className: props.configured ? 'gs-badge' : 'gs-badgeMuted', children: props.stateLabel })
        ] }),
        jsx.jsx('input', {
          id: props.id,
          className: 'gs-input',
          type: 'password',
          value: props.text,
          placeholder: '',
          disabled: props.disabled,
          onChange: function (event) { props.onEdit(event.target.value); }
        }),
        jsx.jsx('p', { className: 'gs-hint', children: props.hint || '' })
      ] });
    }

    // ---- card component ----
    function GitSyncCard(props) {
      var t = props.t;
      var state = props.useGitSyncCard(function (snapshot) { return snapshot; });
      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      if (!state.available) return null;
      var blocked = !state.dirty || state.invalid || state.saving;
      var title = t('gitSyncTitle');
      return jsx.jsx('li', {
        className: 'gs-card',
        children: jsx.jsxs('div', { children: [
          jsx.jsxs('button', {
            type: 'button',
            className: 'gs-header',
            'aria-expanded': open,
            'aria-label': t(open ? 'collapse' : 'expand') + ': ' + title,
            onClick: function () { setOpen(!open); },
            children: [
              jsx.jsxs('span', { className: 'gs-headText', children: [
                jsx.jsx('span', { className: 'gs-name', children: title }),
                jsx.jsx('span', { className: 'gs-desc', children: t('gitSyncDescription') })
              ] }),
              state.dirty ? jsx.jsx('span', { className: 'gs-pending', children: t('unsaved') }) : null,
              jsx.jsx('span', { className: open ? 'gs-chevron gs-chevronOpen' : 'gs-chevron' })
            ]
          }),
          open ? jsx.jsxs('div', { className: 'gs-body', children: [
              !state.writable ? jsx.jsx('p', { className: 'gs-readonly', role: 'status', children: t('readOnly') }) : null,
              jsx.jsx(SecretField, { id: 'gs-token', label: t('tokenLabel'), hint: t('tokenHint'),
                stateLabel: state.tokenConfigured ? t('tokenSet') : t('tokenUnset'),
                configured: state.tokenConfigured, disabled: !state.tokenWritable,
                text: state.token.text, onEdit: function (v) { props.edit('token', v); } }),
              jsx.jsx(ValueField, { id: 'gs-username', label: t('usernameLabel'), hint: t('usernameHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable,
                ...state['github.username'],
                onEdit: function (v) { props.edit('github.username', v); },
                onReset: function () { props.resetField('github.username'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-visibility', label: t('visibilityLabel'), hint: t('visibilityHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state['github.visibility'],
                onEdit: function (v) { props.edit('github.visibility', v); },
                onReset: function () { props.resetField('github.visibility'); } }),
              jsx.jsx(ValueField, { id: 'gs-branch', label: t('defaultBranchLabel'), hint: t('defaultBranchHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable,
                ...state['github.defaultBranch'],
                onEdit: function (v) { props.edit('github.defaultBranch', v); },
                onReset: function () { props.resetField('github.defaultBranch'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-insecure-tls', label: t('insecureTlsLabel'), hint: t('insecureTlsHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state['github.insecureTls'],
                onEdit: function (v) { props.edit('github.insecureTls', v); },
                onReset: function () { props.resetField('github.insecureTls'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-auth-method', label: t('authMethodLabel'), hint: t('authMethodHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state['auth.method'],
                onEdit: function (v) { props.edit('auth.method', v); },
                onReset: function () { props.resetField('auth.method'); } }),
              jsx.jsx(ValueField, { id: 'gs-committer-name', label: t('committerNameLabel'), hint: t('committerNameHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable,
                ...state['git.committerName'],
                onEdit: function (v) { props.edit('git.committerName', v); },
                onReset: function () { props.resetField('git.committerName'); } }),
              jsx.jsx(ValueField, { id: 'gs-committer-email', label: t('committerEmailLabel'), hint: t('committerEmailHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable,
                ...state['git.committerEmail'],
                onEdit: function (v) { props.edit('git.committerEmail', v); },
                onReset: function () { props.resetField('git.committerEmail'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-autosync', label: t('autoSyncLabel'), hint: t('autoSyncHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state.autoSync,
                onEdit: function (v) { props.edit('autoSync', v); },
                onReset: function () { props.resetField('autoSync'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-ask-init', label: t('askBeforeInitLabel'), hint: t('askBeforeInitHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state.askBeforeInit,
                onEdit: function (v) { props.edit('askBeforeInit', v); },
                onReset: function () { props.resetField('askBeforeInit'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-gitignore', label: t('createGitignoreLabel'), hint: t('createGitignoreHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state['init.createGitignore'],
                onEdit: function (v) { props.edit('init.createGitignore', v); },
                onReset: function () { props.resetField('init.createGitignore'); } }),
              jsx.jsx(ValueField, { id: 'gs-init-msg', label: t('initialCommitLabel'), hint: t('initialCommitHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable,
                ...state['init.initialCommitMessage'],
                onEdit: function (v) { props.edit('init.initialCommitMessage', v); },
                onReset: function () { props.resetField('init.initialCommitMessage'); } }),
              jsx.jsx(ChoiceField, { id: 'gs-scan-secrets', label: t('scanSecretsLabel'), hint: t('scanSecretsHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), disabled: !state.writable, t: t,
                field: state['safety.scanForSecrets'],
                onEdit: function (v) { props.edit('safety.scanForSecrets', v); },
                onReset: function () { props.resetField('safety.scanForSecrets'); } }),
              jsx.jsx(ValueField, { id: 'gs-max-size', label: t('maxSizeLabel'), hint: t('maxSizeHint'),
                overriddenLabel: t('overridden'), resetLabel: t('reset'), invalidLabel: t('invalidNumber'),
                numeric: true, disabled: !state.writable,
                ...state['safety.maxFileSizeMb'],
                onEdit: function (v) { props.edit('safety.maxFileSizeMb', v); },
                onReset: function () { props.resetField('safety.maxFileSizeMb'); } }),
              state.failed ? jsx.jsx('p', { className: 'gs-failed', role: 'status', children: t('saveFailed') }) : null,
              jsx.jsxs('div', { className: 'gs-footer', children: [
                jsx.jsx('button', { type: 'button', className: 'gs-discard', disabled: !state.dirty || state.saving,
                  onClick: props.discard, children: t('discard') }),
                jsx.jsx('button', { type: 'button', className: 'gs-save', disabled: blocked,
                  onClick: props.save, children: t(state.saving ? 'saving' : 'save') })
              ] })
            ] }) : null
          ] })
      });
    }

    // ---- locales ----
    var en = {
      gitSyncTitle: 'GitHub sync',
      gitSyncDescription: 'Git + GitHub automation: ask-before-init repos, auto-sync on code updates.',
      tokenLabel: 'GitHub token',
      tokenHint: 'Stored outside the settings file. Leave blank to keep the current token.',
      tokenSet: 'A token is configured.',
      tokenUnset: 'No token is configured.',
      usernameLabel: 'GitHub username / org',
      usernameHint: 'Owner for created repos; blank uses the token account.',
      visibilityLabel: 'Default visibility',
      visibilityHint: 'Visibility for newly created repositories.',
      defaultBranchLabel: 'Default branch',
      defaultBranchHint: 'Branch created on git init.',
      insecureTlsLabel: 'Insecure TLS',
      insecureTlsHint: 'Enable only when your machine has a broken TLS chain (interception).',
      authMethodLabel: 'git credential injection',
      authMethodHint: 'extraheader (recommended) or askpass.',
      committerNameLabel: 'Commit author name',
      committerNameHint: 'Blank uses the GitHub username.',
      committerEmailLabel: 'Commit author email',
      committerEmailHint: 'Blank uses the GitHub noreply address.',
      autoSyncLabel: 'Auto-sync on turn end',
      autoSyncHint: 'true: auto commit+push; false: only via git_sync; ask: ask first.',
      askBeforeInitLabel: 'Ask before creating a repo',
      askBeforeInitHint: 'Whether git_init asks the user before creating a repository.',
      createGitignoreLabel: 'Create .gitignore',
      createGitignoreHint: 'Generate a .gitignore on repo init.',
      initialCommitLabel: 'Initial commit message',
      initialCommitHint: 'Message used for the first commit.',
      scanSecretsLabel: 'Scan for secrets',
      scanSecretsHint: 'Block commits containing sensitive files (.env, keys, ...).',
      maxSizeLabel: 'Large-file warning (MB)',
      maxSizeHint: 'Files above this size ask before commit (GitHub limit 100MB).',
      private: 'Private', public: 'Public', enabled: 'Enabled', disabled: 'Disabled',
      extraheader: 'extraheader', askpass: 'askpass', ask: 'Ask',
      overridden: 'Overridden', reset: 'Reset to default', readOnly: 'This deployment stores settings read-only.',
      save: 'Save', saving: 'Saving…', discard: 'Discard', unsaved: 'Unsaved',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      invalidNumber: 'Enter a number, or leave blank to use the default.',
      expand: 'Show settings', collapse: 'Hide settings'
    };
    var zh = {
      gitSyncTitle: 'GitHub 同步',
      gitSyncDescription: 'Git + GitHub 自动化：建仓前询问、代码更新自动同步。',
      tokenLabel: 'GitHub 令牌',
      tokenHint: '存储在设置文件之外；留空保留当前令牌。',
      tokenSet: '已配置令牌。',
      tokenUnset: '未配置令牌。',
      usernameLabel: 'GitHub 用户名 / 组织',
      usernameHint: '建仓 owner；留空使用令牌对应账号。',
      visibilityLabel: '默认可见性',
      visibilityHint: '新建仓库的默认可见性。',
      defaultBranchLabel: '默认分支',
      defaultBranchHint: 'git init 时创建的分支名。',
      insecureTlsLabel: '跳过 TLS 校验',
      insecureTlsHint: '仅当本机 TLS 证书链异常（被拦截）时开启。',
      authMethodLabel: 'git 凭据注入方式',
      authMethodHint: 'extraheader（推荐）或 askpass。',
      committerNameLabel: '提交作者名',
      committerNameHint: '留空使用 GitHub 用户名。',
      committerEmailLabel: '提交作者邮箱',
      committerEmailHint: '留空使用 GitHub noreply 邮箱。',
      autoSyncLabel: '回合结束自动同步',
      autoSyncHint: 'true：自动提交推送；false：仅 git_sync 时同步；ask：先询问。',
      askBeforeInitLabel: '建仓前询问',
      askBeforeInitHint: 'git_init 是否先询问用户再创建仓库。',
      createGitignoreLabel: '生成 .gitignore',
      createGitignoreHint: '建仓时自动生成 .gitignore。',
      initialCommitLabel: '首次提交信息',
      initialCommitHint: '首次提交使用的提交信息。',
      scanSecretsLabel: '敏感文件扫描',
      scanSecretsHint: '阻止提交包含敏感文件（.env、密钥等）的变更。',
      maxSizeLabel: '大文件告警（MB）',
      maxSizeHint: '超过该大小的文件提交前会询问（GitHub 上限 100MB）。',
      private: '私有', public: '公开', enabled: '启用', disabled: '禁用',
      extraheader: 'extraheader', askpass: 'askpass', ask: '询问',
      overridden: '已覆盖', reset: '重置为默认', readOnly: '此部署的设置只读。',
      save: '保存', saving: '保存中…', discard: '放弃', unsaved: '未保存',
      saveFailed: '此部署未接受这些值；已保留供你修改。',
      invalidNumber: '请输入数字，或留空使用默认值。',
      expand: '展开设置', collapse: '收起设置'
    };

    // ---- plugin entry ----
    var inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope'];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { en: en, zh: zh });
      }, 'git-sync: locale dictionaries');
      var api = ctx.get('connection').api;
      var scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
      var describeFace = ctx.settingsScope.describe();
      var controller = new GitSyncCardController(scope, describeFace, api);
      ctx.effect(function () {
        return ctx.remote.$on('credentials/reference-updated', function (ref) {
          controller.refreshCredential(ref);
        });
      }, 'git-sync: credential invalidations');
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          locale: NS,
          inject: function () { return controller.inject(); }
        }, GitSyncCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
