window.__ModuleLoader__.load({ id: "dsh-skill-mcp-manager", factory: (require) => {

  // Pure-JS client bundle (no JSX/TS). Registers one "能力库 (Capability)"
  // settings section with 技能/MCP tabs. Talks to the host over same-origin
  // HTTP routes mounted by lib/ui.js.

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-skill-mcp-manager";
  const inject = ["slots"];

  // ── fetch ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function errText(error) {
    return String(error && error.message ? error.message : error);
  }

  // ── primitives ───────────────────────────────────────────────────────────
  function Switch(props) {
    const checked = props.checked === true;
    const disabled = props.disabled === true;
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      className: cx("smx-switch", checked && "is-on"),
      disabled,
      onClick: () => props.onChange(!checked),
    }, h("span", { className: "smx-switch__knob" }));
  }

  function Badge(props) {
    return h("span", { className: cx("smx-badge", props.tone ? "smx-badge--" + props.tone : "") }, props.children);
  }

  function Notice(props) {
    return h("div", { className: cx("smx-notice", props.kind ? "smx-notice--" + props.kind : "") },
      h("span", null, props.children),
      props.onDismiss
        ? h("button", { type: "button", className: "smx-notice__close", onClick: props.onDismiss }, "\u00d7")
        : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "smx-empty" }, props.children);
  }

  // ── legacy session notice ────────────────────────────────────────────────
  // Sessions written before 1.1.5 cannot be opened once DSH reaches 2.0.9. The
  // host scans for them on every start while its `check` flag is set, reports the
  // count, and retires the flag by itself once a scan finds nothing. This only
  // points at the repair guide — nothing here repairs anything, and there is no
  // dismiss: an accidental click must not be able to hide a real problem.
  const REPAIR_GUIDE_URL = "https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2";
  const AUDIT_POLL_MS = 5000;
  const AUDIT_POLL_LIMIT = 36;

  // The host reports a running scan explicitly, and the answer may take tens of
  // seconds on a large library, so poll while either is unsettled. A settled
  // check never polls at all.
  function useLegacyAudit() {
    const [audit, setAudit] = useState(null);
    useEffect(() => {
      let cancelled = false;
      let timer = null;
      let attempts = 0;
      const load = async () => {
        try {
          const data = await getJson("/skill-mcp-manager/session-audit");
          if (cancelled) return;
          setAudit(data);
          const unsettled = data.scanning === true || data.affected > 0;
          if (unsettled && attempts < AUDIT_POLL_LIMIT) {
            attempts += 1;
            timer = setTimeout(load, AUDIT_POLL_MS);
          }
        } catch {
          /* advisory only — a failed fetch stays silent */
        }
      };
      load();
      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    }, []);
    return audit;
  }

  function legacySessionsOpen(audit) {
    return audit !== null && audit.scanning !== true && audit.check !== false && audit.affected > 0;
  }

  function auditScanning(audit) {
    return audit !== null && audit.scanning === true;
  }

  // The result is told once per browser session, and the fact that it was told
  // is remembered in sessionStorage rather than on the host — a plugin whose one
  // job here is telling the user something should not grow a state file and a
  // write route to remember that the telling happened.
  //
  // The wait notice and the result toast need separate keys, because they are
  // separate conditions rather than one shared "already told" flag: they used to
  // share one, and closing the wait notice then counted as having told the
  // result, so the result was never shown at all (found on-machine 2026-09-14).
  const CHECK_TOAST_KEY = "dsh-skill-mcp-manager:checking-seen";
  const RESULT_TOAST_KEY = "dsh-skill-mcp-manager:result-shown";

  function sessionRemember(key) {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* a browser that refuses storage just shows the notice again */
    }
  }

  function sessionSeen(key) {
    try {
      return window.sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  // The settled answer of a scan that ran in this process, told once for this
  // browser session. `checked` is what makes the difference between news and an
  // old conclusion: a retired check reads its record off disk on every start, and
  // announcing that as a result is what made "没有会话受影响" re-appear on every
  // restart (2026-09-14, on-machine). The banner does not use this at all: while
  // the check is open and something is affected it stays on screen.
  function auditResultShown(audit) {
    if (audit === null || audit.done !== true || audit.checked !== true || auditScanning(audit)) return false;
    return !sessionSeen(RESULT_TOAST_KEY);
  }

  // The banner is dismissed for the session, and — the mistake above — that must
  // not read as the result having been told.
  function bannerAvailable(audit) {
    return legacySessionsOpen(audit);
  }

  // Settings-page banner: the full explanation and the report to hand to an AI.
  // Whether it appears is decided by the host state alone — the check is open and
  // something is affected — so it comes back with the page and leaves only when
  // the problem is dealt with. Its close hides it just for this mount.
  function LegacySessionBanner() {
    const audit = useLegacyAudit();
    const [closed, setClosed] = useState(false);
    if (closed || !bannerAvailable(audit)) return null;
    return h(Notice, { kind: "error", onDismiss: () => {
      setClosed(true);
    } },
      h("span", { className: "smx-legacy" },
        h("span", { className: "smx-legacy__title" }, `因 DSH 版本升级，有 ${audit.affected} 个历史会话无法查看`),
        h("span", null,
          "DSH 升级后调整了 MCP 注入消息的格式规范，旧会话的 MCP 注入消息不再被支持，打开时会显示",
          h("code", { className: "smx-legacy__code" }, "历史加载失败：failed to observe session … cannot safely transform unclassified message source"),
          "。把上面这段报错交给 AI，让它去修；插件的提示里不含修复操作，详情见",
          h("a", { className: "smx-legacy__link", href: REPAIR_GUIDE_URL, target: "_blank", rel: "noreferrer" }, "本项目 issue"),
        ),
        h("span", { className: "smx-legacy__note" },
          "修好后不需要手动关闭：下次启动扫描到 0 会自动停止。若你决定不修复这些会话，把 ",
          h("code", { className: "smx-legacy__code" }, "~/.dsh/skill-mcp-manager/session-audit.json"),
          " 里的 ",
          h("code", { className: "smx-legacy__code" }, `"check": false`),
          " 写入即可停止提示。",
        ),
      ),
    );
  }

  // One toast per state. While the check runs it says so and asks for patience;
  // when the answer lands it replaces that with the result — a problem to hand
  // to an AI, or an all-clear. Closing the wait notice does not stop the check,
  // so the result still gets its turn.
  //
  // Closing goes through sessionStorage for both, so a closed notice stays
  // closed after a reload — and, because the two keys differ, closing the wait
  // notice can no longer swallow the result.
  function LegacySessionOverlay() {
    const audit = useLegacyAudit();
    // Closing writes to sessionStorage, not to React state, so it has to force a
    // render to take effect.
    const [, setTick] = useState(0);
    const checking = auditScanning(audit);
    const shown = auditResultShown(audit);
    if (checking && !sessionSeen(CHECK_TOAST_KEY)) {
      return h("div", { className: "smx-toast smx-toast--checking", role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, "因 DSH 版本升级，历史会话可能无法打开，能力库正在检查"),
          h("div", { className: "smx-toast__text" }, "若历史会话较多，可能需要一些时间，请耐心等待；检查期间历史会话目录可能暂时无法查看。本检查是一次性临时动作，修复后不会再次出现。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: "本次不再显示",
          onClick: () => {
            sessionRemember(CHECK_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    if (shown) {
      const affected = audit.affected;
      return h("div", { className: "smx-toast" + (affected > 0 ? " smx-toast--alert" : " smx-toast--ok"), role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, affected > 0
            ? `因 DSH 版本升级，有 ${affected} 个历史会话无法查看`
            : "没有会话受影响，请放心使用"),
          h("div", { className: "smx-toast__text" }, affected > 0
            ? "把报错交给 AI，让它去修；详情见「设置 → 能力库」。"
            : "历史会话检查已完成，以后不会再检查。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: affected > 0 ? "本次不再显示" : "知道了",
          onClick: () => {
            sessionRemember(RESULT_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    return null;
  }

  function kv(key, value) {
    return h("div", { className: "smx-kv", key },
      h("span", { className: "smx-kv__k" }, key),
      h("span", { className: "smx-kv__v" }, value === null || value === undefined || value === "" ? "\u2014" : String(value)),
    );
  }

  // ── shared page pieces ───────────────────────────────────────────────────
  function PageHeader(props) {
    return h("header", { className: "smx-header" },
      h("div", { className: "smx-header__row" },
        h("h2", { className: "smx-title" }, props.title),
        props.actions ? h("div", { className: "smx-head__meta" }, props.actions) : null,
      ),
      props.subtitle ? h("div", { className: "smx-subtitle" }, props.subtitle) : null,
    );
  }

  function Group(props) {
    return h("section", { className: "smx-group" },
      h("div", { className: "smx-group__head" },
        h("span", { className: "smx-group__title" }, props.title),
        h("span", { className: "smx-group__count" }, String(props.count)),
      ),
      props.hint ? h("div", { className: "smx-group__hint" }, props.hint) : null,
      props.children,
    );
  }

  function Kv(props) {
    const value = props.value;
    if (value === null || value === undefined || value === "") return null;
    return h("div", { className: "smx-kv" },
      h("span", { className: "smx-kv__k" }, props.label),
      h("span", { className: "smx-kv__v" }, String(value)),
    );
  }

  function configRows(server) {
    const envKeys = Object.keys(server.env || {});
    const headerKeys = Object.keys(server.headers || {});
    return h("div", { className: "smx-kvlist" },
      h(Kv, { label: "传输", value: server.transport }),
      h(Kv, { label: "命令", value: server.command }),
      h(Kv, { label: "参数", value: (server.args || []).join(" ") }),
      h(Kv, { label: "URL", value: server.url }),
      h(Kv, { label: "工作目录", value: server.cwd }),
      envKeys.length > 0
        ? h("div", { className: "smx-detail__section" },
            h("div", { className: "smx-detail__label" }, "环境变量"),
            envKeys.map((key) => h(Kv, { key: key, label: key, value: server.env[key] })),
          )
        : null,
      headerKeys.length > 0
        ? h("div", { className: "smx-detail__section" },
            h("div", { className: "smx-detail__label" }, "Headers"),
            headerKeys.map((key) => h(Kv, { key: key, label: key, value: server.headers[key] })),
          )
        : null,
    );
  }

  // One server's tools. Managed rows carry the per-tool switch (the plugin owns
  // the connection); every other row shows the list read-only, because the tool
  // set belongs to the layer that declared it.
  function toolList(server, managed, onToggle) {
    const tools = server.live && Array.isArray(server.live.tools) ? server.live.tools : [];
    if (tools.length === 0) {
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "工具"),
        h(Empty, null, managed ? "没有工具快照（可刷新快照）" : "没有注册到模型的工具"),
      );
    }
    return h("div", { className: "smx-detail__section" },
      h("div", { className: "smx-detail__label" }, "工具 (" + tools.length + ")"),
      h("ul", { className: "smx-tools" },
        tools.map((tool) => h("li", {
          key: tool.name,
          className: cx("smx-tool", tool.enabled === false && "is-disabled"),
        },
          managed && onToggle
            ? h("select", {
                className: "smx-tool__tier",
                value: tool.enabled === false ? "disabled" : "enabled",
                "aria-label": tool.name + " 档位",
                onChange: (event) => onToggle(tool, event.target.value === "enabled"),
              },
              h("option", { value: "enabled" }, "启用"),
              h("option", { value: "disabled" }, "禁用"),
            )
            : null,
          h("div", { className: "smx-tool__main" },
            h("div", { className: "smx-tool__name" }, tool.name),
            tool.description ? h("div", { className: "smx-tool__desc" }, tool.description) : null,
          ),
        )),
      ),
    );
  }

  // ── MCP page ─────────────────────────────────────────────────────────────
  const TIERS = ["eager", "on-demand", "disabled"];
  const TIER_LABEL = { "eager": "常驻", "on-demand": "按需", "disabled": "关闭" };
  const TIER_TONE = { "eager": "success", "on-demand": "info", "disabled": "muted" };
  const SOURCE_LABEL = { managed: "托管", native: "用户补丁", bundle: "捆绑", builtin: "内置" };
  const SOURCE_HINT = {
    managed: "本插件接管或登记的行：可改档位、逐工具开关、删除",
    native: "留在用户补丁层、本插件没有接管的行：只能停用/启用",
    bundle: "由其它 bundle 提供的行：只能停用/启用与重启，配置属于该 bundle",
    builtin: "宿主内置的工具集：只读",
  };
  const SOURCE_ORDER = ["managed", "native", "bundle", "builtin"];
  const APPROVAL_OPTIONS = [
    ["follow", "跟随当前对话的 DSH 权限"],
    ["always-ask", "每次都问"],
    ["always-allow", "始终放行"],
  ];

  function McpPage() {
    const [inventory, setInventory] = useState(null);
    const [legacyHost, setLegacyHost] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [reveal, setReveal] = useState(false);
    const [detail, setDetail] = useState("");
    const [confirming, setConfirming] = useState("");
    const [output, setOutput] = useState("");
    const [busyKey, setBusyKey] = useState("");
    const [toolDescMax, setToolDescMax] = useState(150);
    const [toolDescDraft, setToolDescDraft] = useState("150");
    const [bufferMb, setBufferMb] = useState(null);
    const [bufferDraft, setBufferDraft] = useState("");
    const [approval, setApproval] = useState("follow");
    const [hosts, setHosts] = useState("");
    const [profile, setProfile] = useState(null);
    const [profileChoice, setProfileChoice] = useState("");
    const [profileBusy, setProfileBusy] = useState(false);
    const [profileConfirm, setProfileConfirm] = useState("");

    const refresh = useCallback(async (rv) => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/inventory" + (rv ? "?reveal=1" : ""));
        setLegacyHost(false);
        setInventory(data);
      } catch (err) {
        // A host process that has not been restarted since this client shipped
        // has no /inventory route yet. Degrade to the managed list instead of
        // showing an empty page: every action on a managed row still works.
        if (/HTTP 404/.test(errText(err))) {
          try {
            const data = await getJson("/skill-mcp-manager/mcp" + (rv ? "?reveal=1" : ""));
            const entries = data.entries || [];
            setLegacyHost(true);
            setInventory({
              servers: entries.map((entry) => Object.assign({}, entry, {
                serverKey: entry.name,
                source: "managed",
                enabled: entry.tier !== "disabled",
                editable: true,
                removable: true,
                restartable: false,
                live: {
                  mounted: entry.tier !== "disabled",
                  phase: entry.tier,
                  toolCount: entry.toolCount,
                  tools: entry.tools || [],
                },
              })),
              counts: { managed: entries.length, native: 0, bundle: 0, builtin: 0 },
              bundleAvailable: false,
            });
          } catch (fallbackError) {
            setError(errText(fallbackError));
          }
        } else {
          setError(errText(err));
        }
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(false); }, [refresh]);

    const loadProfile = useCallback(async () => {
      try {
        const data = await getJson("/skill-mcp-manager/profile");
        setProfile(data);
        if (typeof data.choice === "string") setProfileChoice(data.choice);
      } catch (err) {
        setError(errText(err));
      }
    }, []);

    useEffect(() => { loadProfile(); }, [loadProfile]);

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          const value = data.toolDescriptionMaxLength;
          if (typeof value === "number" && value > 0) {
            setToolDescMax(value);
            setToolDescDraft(String(value));
          }
          const mb = data.stdioMaxBufferSizeMb;
          if (typeof mb === "number" && mb > 0) {
            setBufferMb(mb);
            setBufferDraft(String(mb));
          }
          if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
          if (Array.isArray(data.lanHostAllowlist)) setHosts(data.lanHostAllowlist.join(", "));
        })
        .catch(() => {});
    }, []);

    async function saveToolDesc() {
      const value = Number(toolDescDraft);
      if (!Number.isInteger(value) || value <= 0 || value > 5000) {
        setError("工具描述截断必须是 1–5000 的正整数");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { toolDescriptionMaxLength: value });
        setToolDescMax(value);
        setNotice("已更新工具描述截断为 " + value);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function saveBufferMb() {
      const text = bufferDraft.trim();
      // Empty clears the override (back to the SDK default of 10 MB).
      const value = text === "" ? null : Number(text);
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        setError("stdio 消息上限必须是正整数（MB），留空表示使用 SDK 默认 10 MB");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { stdioMaxBufferSizeMb: value });
        setBufferMb(value);
        setBufferDraft(value === null ? "" : String(value));
        setNotice(value === null
          ? "已恢复 SDK 默认上限 10 MB；新上限对之后 mcp_load 的连接生效"
          : "已把 stdio 消息上限调到 " + value + " MB；对之后 mcp_load 的连接生效");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function saveSecurity() {
      const lanHostAllowlist = hosts.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      try {
        const data = await postJson("/skill-mcp-manager/settings", { localCommandApproval: approval, lanHostAllowlist: lanHostAllowlist });
        if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
        setHosts(Array.isArray(data.lanHostAllowlist) ? data.lanHostAllowlist.join(", ") : "");
        setNotice("已保存");
      } catch (err) {
        setError(errText(err));
      }
    }

    // Switching is a handover, not a preference: the released profile goes back
    // to its native rows, the new one is taken over, and the second click on the
    // button is the confirmation step.
    async function applyProfile() {
      const next = profileChoice;
      const current = profile && profile.target ? profile.target.name : "";
      if (next !== current && profileConfirm !== next) {
        setProfileConfirm(next);
        setNotice("");
        setError("");
        return;
      }
      setProfileConfirm("");
      setProfileBusy(true);
      try {
        const data = await postJson("/skill-mcp-manager/profile", { name: next });
        setProfile(data);
        if (typeof data.choice === "string") setProfileChoice(data.choice);
        const targetName = data.target ? data.target.name : next;
        setNotice(data.switched === true
          ? "已接管 " + targetName + "（交还 " + data.previous + "，导入 " + data.imported + " 条）"
            + (data.settingsPersisted === false ? "；注意：选择没有写进 settings.json，重启后会回到原目标" : "")
          : "管理目标已是 " + targetName + "，仅记录了选择");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      } finally {
        setProfileBusy(false);
      }
    }

    async function toggleReveal() {
      const next = !reveal;
      setReveal(next);
      await refresh(next);
    }

    async function setTier(server, tier) {
      setBusyKey(server.serverKey);
      try {
        const upgrading = server.tier === "on-demand" && tier === "eager";
        await postJson("/skill-mcp-manager/mcp/tier", { name: server.serverKey, tier: tier });
        setNotice(upgrading
          ? "已升至常驻（运行中注册，会话前缀失效一次）"
          : "已切换「" + server.serverKey + "」到 " + (TIER_LABEL[tier] || tier));
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyKey("");
      }
    }

    async function setToolEnabled(server, tool, enabled) {
      try {
        await postJson("/skill-mcp-manager/mcp/tool-tier", {
          name: server.serverKey,
          tool: tool.name,
          enabled: enabled,
        });
        setNotice("已" + (enabled ? "启用 " : "禁用 ") + server.serverKey + "/" + tool.name);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function run(server, peek) {
      setOutput("");
      try {
        const data = await postJson("/skill-mcp-manager/mcp/load", { name: server.serverKey, peek: peek === true });
        setOutput(data.text || "");
        setNotice(peek ? "已查看描述" : "已刷新快照");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(server) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/mcp/delete", { name: server.serverKey });
        setNotice("已删除 " + server.serverKey);
        setDetail("");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    // A row this plugin does not own: the patch layer's disabled override is the
    // only lever, and it takes effect when the tree re-composes (~1s).
    async function toggleRow(server) {
      setBusyKey(server.serverKey);
      try {
        await postJson("/skill-mcp-manager/row/toggle", { id: server.id, enabled: !server.enabled });
        setNotice((server.enabled ? "已停用 " : "已启用 ") + server.serverKey + "（补丁热生效约 1 秒）");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyKey("");
      }
    }

    async function restartRow(server) {
      setBusyKey(server.serverKey);
      try {
        const data = await postJson("/skill-mcp-manager/row/restart", { name: server.serverKey });
        setNotice(data.message || ("已重启 " + server.serverKey));
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyKey("");
      }
    }

    function detailBlock(server) {
      const isManaged = server.source === "managed";
      return h("div", { className: "smx-detail" },
        isManaged
          ? h("div", { className: "smx-detail__section" },
              h("div", { className: "smx-detail__label" }, "档位"),
              h("select", {
                className: "smx-select",
                value: server.tier,
                onChange: (event) => setTier(server, event.target.value),
              }, TIERS.map((tier) => h("option", { key: tier, value: tier }, TIER_LABEL[tier] + " (" + tier + ")"))),
            )
          : null,
        h("div", { className: "smx-kvlist" },
          h(Kv, { label: "来源", value: SOURCE_LABEL[server.source] || server.source }),
          h(Kv, { label: "行 id", value: server.id }),
          h(Kv, { label: "运行状态", value: server.live ? (server.live.phase || "") + (server.live.mounted ? "" : " · 未挂载") : "" }),
          h(Kv, { label: "服务器自报名", value: server.serverName }),
          h(Kv, { label: "版本", value: server.serverVersion }),
          h(Kv, { label: "标题", value: server.serverTitle }),
          h(Kv, { label: "描述", value: server.serverDescription }),
          h(Kv, { label: "网站", value: server.websiteUrl }),
          h(Kv, { label: "使用说明", value: server.instructions }),
          h(Kv, { label: "备注", value: server.notes }),
          h(Kv, { label: "上次刷新快照", value: server.lastLoadAt }),
        ),
        configRows(server),
        toolList(server, isManaged, (tool, enabled) => setToolEnabled(server, tool, enabled)),
        isManaged
          ? h("div", { className: "smx-detail__actions" },
              h("button", { type: "button", className: "smx-btn", onClick: () => run(server, true) }, "查看描述"),
              h("button", { type: "button", className: "smx-btn", onClick: () => run(server, false) }, "刷新快照"),
            )
          : null,
        isManaged && output ? h("pre", { className: "smx-output" }, output) : null,
      );
    }

    function serverRow(server) {
      const key = server.serverKey;
      const isOpen = detail === key;
      const isManaged = server.source === "managed";
      const tone = isManaged ? (TIER_TONE[server.tier] || "muted") : (server.enabled ? "info" : "muted");
      const stateLabel = isManaged
        ? (TIER_LABEL[server.tier] || server.tier)
        : (server.enabled ? "启用" : "停用");
      return h("li", { key: key + ":" + server.source, className: cx("smx-row smx-row--col", !server.enabled && "is-off") },
        h("div", { className: "smx-row__head" },
          h("div", { className: "smx-row__main" },
            h("div", { className: "smx-row__top" },
              h("span", { className: "smx-row__name" }, key),
              h(Badge, { tone: tone }, stateLabel),
              h(Badge, { tone: "muted" }, SOURCE_LABEL[server.source] || server.source),
              server.transport ? h("span", { className: "smx-row__meta" }, server.transport) : null,
              h("span", { className: "smx-row__meta" }, String(server.live ? server.live.toolCount : 0) + " 工具"),
              server.label ? h("span", { className: "smx-row__meta" }, server.label) : null,
              server.connectFailed ? h(Badge, { tone: "muted" }, "连接失败") : null,
            ),
            server.serverDescription ? h("div", { className: "smx-row__desc" }, server.serverDescription) : null,
          ),
          h("div", { className: "smx-row__actions" },
            isManaged
              ? h("select", {
                  className: "smx-select",
                  value: server.tier,
                  disabled: busyKey === key,
                  "aria-label": key + " 档位",
                  onChange: (event) => setTier(server, event.target.value),
                }, TIERS.map((tier) => h("option", { key: tier, value: tier }, TIER_LABEL[tier])))
              : h("label", { className: "smx-switchline" },
                  h(Switch, {
                    checked: server.enabled,
                    disabled: busyKey === key,
                    onChange: () => toggleRow(server),
                  }),
                  h("span", { className: "smx-switchline__label" }, server.enabled ? "启用" : "停用"),
                ),
            !isManaged && server.restartable
              ? h("button", {
                  type: "button",
                  className: "smx-btn",
                  disabled: busyKey === key,
                  onClick: () => restartRow(server),
                }, "重启")
              : null,
            h("button", { type: "button", className: "smx-btn", onClick: () => setDetail(isOpen ? "" : key) }, isOpen ? "收起" : "详情"),
            isManaged
              ? (confirming === key
                  ? h("span", { className: "smx-confirm" },
                      h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(server) }, "确认删除条目"),
                      h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
                    )
                  : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(key) }, "删除"))
              : null,
          ),
        ),
        isOpen ? detailBlock(server) : null,
      );
    }

    // Managed-profile row: which profile's MCP library this plugin owns, where
    // its patch lives, and the warnings that make a target dangerous.
    function profileBlock() {
      if (profile === null) return null;
      const target = profile.target || {};
      const list = profile.profiles || [];
      const targetEntry = list.find((item) => item.name === target.name);
      const sourceLabel = {
        settings: "设置页固定",
        config: "安装配置指定",
        context: "跟随运行中的 profile",
        argv: "命令行 --profile",
        positional: "命令行 profile 参数",
        default: "兜底默认 web",
      }[target.source] || String(target.source || "");
      const options = [
        h("option", { key: "__default", value: "" }, "默认（安装配置优先，否则跟随运行中的 profile）"),
        h("option", { key: "__auto", value: "auto" }, "自动（忽略安装配置，跟随运行中的 profile）"),
      ].concat(list.map((item) => h("option", { key: item.name, value: item.name },
        item.name
          + (item.booted ? "（当前运行）" : "")
          + (item.pluginInstalled === false ? "（未安装本插件）" : ""))));
      const warnings = [];
      if (typeof target.bootedName === "string" && target.isBooted === false) {
        warnings.push("当前运行的是 " + target.bootedName + "，管理目标却是 " + target.name
          + "：两边互不影响，被交还的 profile 要等它下次启动才会恢复原生 MCP。");
      }
      if (targetEntry && targetEntry.pluginInstalled === false) {
        warnings.push("目标 profile 没有装本插件：接管它的原生 MCP 之后，该 profile 启动时会没有这些服务器。");
      }
      if (typeof profile.legacyOwner === "string" && profile.legacyOwner !== "" && profile.legacyOwner !== target.name) {
        warnings.push("旧版单文件 registry.json 已归入 " + profile.legacyOwner + "，切到它即可看到那批条目。");
      }
      const needsConfirm = profileConfirm !== "" && profileConfirm === profileChoice && profileChoice !== target.name;
      return h("div", { className: "smx-setting smx-setting--block" },
        h("div", { className: "smx-setting__row" },
          h("label", { className: "smx-setting__label" }, "管理 profile"),
          h("select", {
            className: "smx-select",
            value: profileChoice,
            disabled: profileBusy,
            "aria-label": "管理 profile",
            onChange: (event) => { setProfileChoice(event.target.value); setProfileConfirm(""); },
          }, options),
          h("button", {
            type: "button",
            className: "smx-btn",
            disabled: profileBusy,
            onClick: applyProfile,
          }, profileBusy ? "切换中…" : (needsConfirm ? "确认切换" : "应用")),
          h("span", { className: "smx-count" }, "目标 " + target.name + "（" + sourceLabel + "）"),
        ),
        h("div", { className: "smx-setting__hint" },
          "patch: " + (target.patchPath || "") + "\n" + (target.registryFile || "")),
        needsConfirm
          ? h(Notice, { kind: "success" }, "再点一次「确认切换」：把 " + target.name + " 交还原生 MCP，并接管 " + profileChoice + "。")
          : null,
        warnings.map((text, index) => h(Notice, { key: "profile-warn-" + index, kind: "error" }, text)),
      );
    }

    function settingsBlock() {
      return h("div", { className: "smx-group" },
        h("div", { className: "smx-group__head" },
          h("span", { className: "smx-group__title" }, "设置"),
          h("span", { className: "smx-group__count" }, "本插件"),
        ),
        h("div", { className: "smx-setting" },
          h("span", { className: "smx-setting__label" }, "工具描述截断（字符）"),
          h("input", {
            type: "number",
            className: "smx-input",
            value: toolDescDraft,
            min: 1,
            max: 5000,
            onChange: (event) => setToolDescDraft(event.target.value),
          }),
          h("button", { type: "button", className: "smx-btn", onClick: saveToolDesc }, "保存"),
          h("span", { className: "smx-count" }, "当前 " + toolDescMax),
        ),
        h("div", { className: "smx-setting" },
          h("span", { className: "smx-setting__label" }, "stdio 消息上限（MB）"),
          h("input", {
            type: "number",
            className: "smx-input",
            value: bufferDraft,
            min: 1,
            placeholder: "SDK 默认 10",
            onChange: (event) => setBufferDraft(event.target.value),
          }),
          h("button", { type: "button", className: "smx-btn", onClick: saveBufferMb }, "保存"),
          h("span", { className: "smx-count" },
            bufferMb === null ? "当前 SDK 默认 10 MB；超限消息报错但不断连接" : "当前 " + bufferMb + " MB"),
        ),
        h("div", { className: "smx-setting smx-setting--block" },
          h("div", { className: "smx-setting__row" },
            h("label", { className: "smx-setting__label" }, "模型登记本地程序"),
            h("select", {
              className: "smx-select",
              value: approval,
              onChange: (event) => setApproval(event.target.value),
            }, APPROVAL_OPTIONS.map((option) => h("option", { key: option[0], value: option[0] }, option[1]))),
          ),
          h("div", { className: "smx-setting__row" },
            h("label", { className: "smx-setting__label" }, "局域网主机名"),
            h("input", {
              className: "smx-input smx-input--wide",
              value: hosts,
              placeholder: "默认空。只有用电脑名打开管理页时才填写",
              onChange: (event) => setHosts(event.target.value),
            }),
          ),
          h("div", { className: "smx-setting__save" },
            h("button", { type: "button", className: "smx-btn", onClick: saveSecurity }, "保存"),
          ),
        ),
      );
    }

    const servers = inventory && Array.isArray(inventory.servers) ? inventory.servers : [];
    const counts = (inventory && inventory.counts) || {};
    const groups = SOURCE_ORDER
      .map((source) => ({ source: source, rows: servers.filter((server) => server.source === source) }))
      .filter((group) => group.rows.length > 0);

    return h("div", { className: "smx" },
      h(PageHeader, {
        title: "MCP 管理",
        subtitle: "全部 MCP 服务器：本插件托管的、用户补丁层的、其它 bundle 提供的与宿主内置的",
        actions: [
          h("button", { key: "reveal", type: "button", className: "smx-btn", onClick: toggleReveal }, reveal ? "隐藏密钥" : "显示密钥"),
          h("button", { key: "refresh", type: "button", className: "smx-btn", onClick: () => refresh(reveal) }, "刷新"),
        ],
      }),
      profileBlock(),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      legacyHost
        ? h(Notice, { kind: "warning" }, "宿主进程还在运行改动前的插件代码：目前只显示托管条目。请完全退出 DSH 后重新启动，即可看到用户补丁 / 捆绑 / 内置来源。")
        : null,
      !legacyHost && inventory && inventory.bundleAvailable === false
        ? h(Notice, { kind: "warning" }, "本次进程启动的不是管理目标 profile：捆绑段只在管理当前运行的 profile 时可见。")
        : null,
      h("div", { className: "smx-count" }, inventory
        ? String(servers.length) + " 个服务器 · 托管 " + (counts.managed || 0)
          + " · 用户补丁 " + (counts.native || 0)
          + " · 捆绑 " + (counts.bundle || 0)
          + " · 内置 " + (counts.builtin || 0)
        : ""),
      loading
        ? h(Empty, null, "加载中…")
        : groups.length === 0 ? h(Empty, null, "没有 MCP 服务器")
        : groups.map((group) => h(Group, {
            key: group.source,
            title: SOURCE_LABEL[group.source] || group.source,
            count: group.rows.length,
            hint: SOURCE_HINT[group.source] || "",
          }, h("ul", { className: "smx-list" }, group.rows.map(serverRow)))),
      settingsBlock(),
    );
  }

  // ── Skills page ──────────────────────────────────────────────────────────
  function SkillsPage() {
    const [skills, setSkills] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/skills");
        setSkills(data.skills || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    async function toggle(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/toggle", { name: skill.name, enabled: !skill.modelInvocable });
        setSkills((current) => current && current.map((item) =>
          item.name === skill.name ? { ...item, modelInvocable: !skill.modelInvocable } : item,
        ));
      } catch (err) {
        setError(errText(err));
      }
    }

    async function open(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/open", { name: skill.name });
        setNotice("已用系统编辑器打开 " + skill.path);
      } catch (err) {
        setError(errText(err) + " — " + skill.path);
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/skills/delete", { name: skill.name });
        setNotice("已删除 " + skill.name);
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    const rows = (skills || []).map((skill) => h("li", { key: skill.name, className: cx("smx-row", !skill.modelInvocable && "is-off") },
      h("div", { className: "smx-row__main" },
        h("div", { className: "smx-row__top" },
          h("span", { className: "smx-row__name" }, skill.name),
          skill.readonly ? h(Badge, { tone: "muted" }, "只读") : h(Badge, { tone: skill.modelInvocable ? "info" : "muted" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
          skill.source ? h("span", { className: "smx-row__meta" }, skill.source) : null,
        ),
        h("div", { className: "smx-row__path" }, skill.path),
        skill.description ? h("div", { className: "smx-row__desc" }, skill.description) : null,
      ),
      h("div", { className: "smx-row__actions" },
        skill.readonly
          ? h("span", { className: "smx-switchline__label" }, "只读（不可启停）")
          : h("label", { className: "smx-switchline" },
              h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
              h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
            ),
        h("button", { type: "button", className: "smx-btn", onClick: () => open(skill) }, "打开"),
        skill.readonly
          ? null
          : confirming === skill.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, "确认删除整个文件夹"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, "删除"),
      ),
    ));

    return h("div", { className: "smx" },
      h(PageHeader, {
        title: "技能管理",
        subtitle: "Agent 可见的技能（SKILL.md）：路径、来源与模型可见性",
        actions: [h("button", { key: "refresh", type: "button", className: "smx-btn", onClick: refresh }, "刷新")],
      }),
      h(LegacySessionBanner),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      h("div", { className: "smx-count" }, skills
        ? String(skills.length) + " 个技能 · 模型可见 " + skills.filter((skill) => skill.modelInvocable).length + " 个"
        : ""),
      loading ? h(Empty, null, "加载中…")
        : skills && skills.length === 0 ? h(Empty, null, "没有可管理的技能（bundle 型 SKILL.md）")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = [
    ".smx { display:flex; flex-direction:column; gap:12px; min-width:0; }",
    ".smx-header { display:flex; flex-direction:column; gap:2px; }",
    ".smx-header__row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }",
    ".smx-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
    ".smx-head__meta { display:flex; align-items:center; gap:8px; }",
    ".smx-group { display:flex; flex-direction:column; gap:8px; }",
    ".smx-group__head { display:flex; align-items:baseline; gap:8px; }",
    ".smx-group__title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-group__count { font-size:11px; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); }",
    ".smx-group__hint { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-setting { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-setting--block { flex-direction:column; align-items:stretch; gap:10px; }",
    ".smx-setting__row { display:flex; align-items:center; gap:8px; min-width:0; }",
    ".smx-setting__save { display:flex; justify-content:flex-end; align-items:center; gap:8px; }",
    ".smx-setting__label { flex:none; white-space:nowrap; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-setting__hint { font-size:11px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; word-break:break-all; }",
    ".smx-input { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); width:72px; }",
    ".smx-input--wide { width:auto; flex:1; min-width:0; }",
    ".smx-count { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-btn { font-size:12px; line-height:1; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }",
    ".smx-btn:hover:enabled { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-btn:disabled { opacity:.55; cursor:default; }",
    ".smx-btn--ghost { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }",
    ".smx-btn--danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }",
    ".smx-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-row--col { flex-direction:column; }",
    ".smx-row.is-off { opacity:.72; }",
    ".smx-row__head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; width:100%; }",
    ".smx-row__main { min-width:0; flex:1; }",
    ".smx-row__top { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }",
    ".smx-row__name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-row__path { font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }",
    ".smx-row__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__desc { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__actions { display:flex; align-items:center; gap:8px; flex-shrink:0; flex-wrap:wrap; justify-content:flex-end; }",
    ".smx-switchline { display:flex; align-items:center; gap:6px; }",
    ".smx-switchline__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-switch { position:relative; width:30px; height:17px; border-radius:999px; border:none; background:var(--dsw-alias-border-l2); cursor:pointer; padding:0; flex-shrink:0; }",
    ".smx-switch.is-on { background:var(--dsw-alias-brand-primary); }",
    ".smx-switch:disabled { opacity:.55; cursor:default; }",
    ".smx-switch__knob { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; transition:left .12s ease; }",
    ".smx-switch.is-on .smx-switch__knob { left:15px; }",
    ".smx-badge { font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }",
    ".smx-badge--success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-badge--info { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".smx-badge--muted { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }",
    ".smx-notice { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:6px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }",
    ".smx-notice--success { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-notice--error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-notice--warning { border-color:var(--dsw-alias-state-warning-primary, var(--dsw-alias-border-l2)); }",
    ".smx-notice__close { border:none; background:none; color:inherit; cursor:pointer; font-size:14px; padding:0 2px; }",
    ".smx-legacy { display:flex; flex-direction:column; gap:4px; line-height:1.6; text-align:left; }",
    ".smx-legacy__title { font-weight:600; }",
    ".smx-legacy__code { font-family:var(--ds-font-family-code); font-size:11px; padding:1px 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }",
    ".smx-legacy__link { color:var(--dsw-alias-brand-primary); }",
    ".smx-legacy__note { color:var(--dsw-alias-label-secondary); }",
    ".smx-toast { position:absolute; right:16px; bottom:16px; display:flex; align-items:flex-start; gap:10px; max-width:360px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 8px 28px rgba(0,0,0,.18); pointer-events:auto; }",
    ".smx-toast--checking { border-color:var(--dsw-alias-border-l2); }",
    ".smx-toast--ok { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-toast__main { min-width:0; }",
    ".smx-toast__title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-toast__text { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-toast__close { border:none; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }",
    ".smx-empty { padding:18px; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-confirm { display:inline-flex; gap:6px; align-items:center; }",
    ".smx-detail { display:flex; flex-direction:column; gap:8px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:10px; width:100%; }",
    ".smx-detail__section { display:flex; flex-direction:column; gap:4px; }",
    ".smx-detail__label { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); }",
    ".smx-detail__actions { display:flex; gap:8px; flex-wrap:wrap; }",
    ".smx-kvlist { display:flex; flex-direction:column; gap:4px; }",
    ".smx-kv { display:flex; gap:8px; font-size:12px; }",
    ".smx-kv__k { flex-shrink:0; min-width:88px; color:var(--dsw-alias-label-secondary); }",
    ".smx-kv__v { color:var(--dsw-alias-label-primary); word-break:break-all; }",
    ".smx-select { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-select:disabled { opacity:.55; }",
    ".smx-tools { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }",
    ".smx-tool { display:flex; align-items:flex-start; gap:8px; font-size:12px; }",
    ".smx-tool__tier { flex-shrink:0; min-width:58px; font-size:11px; padding:2px 4px; border-radius:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tool__main { min-width:0; }",
    ".smx-tool__name { font-family:ui-monospace,monospace; color:var(--dsw-alias-label-primary); }",
    ".smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool.is-disabled .smx-tool__name, .smx-tool.is-disabled .smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-output { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }",
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    const tagId = "@deepseek-ai/dsh-skill-mcp-manager";
    if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-skill-mcp-manager";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  // One settings nav row per concern, the way the shell's own pages are laid
  // out: MCP management and skill management are separate screens, and the
  // capability page no longer hides both behind a tab strip.
  function apply(ctx) {
    injectCss();
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "mcp-manager",
      order: 35,
      label: "MCP 管理",
    }, McpPage));
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "skills-manager",
      order: 36,
      label: "技能管理",
    }, SkillsPage));
    // Frame-wide notices belong in the shell overlay, not in a settings page:
    // `shell.overlay` is a root-scope `list` slot rendered with no props inside
    // the frame's pointer-events:none layer, so the occupant positions itself
    // and everything around it stays click-through.
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
      name: "shell.overlay",
      id: "capability-legacy-sessions",
      order: 80,
    }, LegacySessionOverlay));
  }

  return { name, inject, apply };
}});
