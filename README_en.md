<p align="center">
  <img src="icon.svg" alt="dsh-cpa-switch" width="80" height="80">
</p>

<h1 align="center">dsh-cpa-switch</h1>

<div align="center">
  <p><strong>Manage your AI channel accounts inside DeepSeek Harness</strong></p>
  <p><em>Balances, check-in, tasks and account switching, without leaving DSH</em></p>

  <p>
    <a href="https://www.npmjs.com/package/dsh-cpa-switch"><img src="https://img.shields.io/npm/v/dsh-cpa-switch?style=flat" alt="npm"></a>
    <a href="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml"><img src="https://github.com/cslkkl/dsh-cpa-switch/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4176E6?style=flat" alt="DeepSeek Harness Plugin"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
  </p>

  <p>
    <a href="README.md">简体中文</a> · <strong><a href="README_en.md">English</a></strong>
  </p>
</div>

Check balances, check in, run tasks and switch accounts — manage CLIProxyAPI (CPA) accounts
inside DSH, without opening its own web console.

Install the plugin and you are done: the CPA binary, the channel plugins, the config and the
admin key are all prepared by the plugin itself.

> [!NOTE]
> **The key never leaves the host**: every action in the panel is performed by the plugin on
> your behalf. The admin key only lives on the host side — the web page can never see it.

## What it does

Open **Plugins → CPA Switch** in DSH. Each of the four channels gets its own tab:

- **See account balances**: available / used / quota pool / package count; tokens and credits
  are shown separately and never summed together.
- **Check in all / run all tasks**: one click per channel; each account can also be operated
  individually.
- **Enable / disable accounts**: every account has a toggle, and "Use only this one" disables
  every other account in the same channel at once.
- **Add an account**: the "+ Add account" entry at the end of each channel's list opens the
  OAuth page — finish the login in your browser and you are done.
- **Remembers your choice**: after a DSH restart, the account you picked is still the one in use.
- **Automatic check-in**: toggled per channel; check-ins missed while DSH was not running are
  caught up when the plugin starts.
- **Process hosting**: CPA starts with DSH (an already-running instance is reused) and stops
  with it.
- **Says why it will not start**: a port taken by another CPA, a config-generation mismatch,
  and a bad config each get their own message; a port held by someone else's instance no longer
  reports "Running".
- **Models registered automatically**: once the plugin is installed and an account is added,
  the four channels' models appear in DSH's model picker on their own.

### The four channels

| Channel   | Accounts | Balance unit | Check-in | Tasks |
| --------- | -------- | ------------ | -------- | ----- |
| WorkBuddy | several  | credits      | ✅       | ✅    |
| Trae      | several  | credits      | ✅       | —     |
| Qoder     | single   | credits      | ✅       | —     |
| ZCode     | single   | **token**    | —        | —     |

The four channels do not report the same balance fields: Trae has a single balance pool and no
total or used figure, so its "used" cell shows `—` and no bar is drawn — that means "upstream did
not say", not "used 0".

**Degrades by capability**: features a channel does not support are not rendered — no button
that "does nothing when clicked".

## Security

The admin key only lives on the host side and is never sent to the browser — details in
[Architecture](docs/ARCHITECTURE.md).

## Requirements

Only **DSH** (DeepSeek Harness). The CPA binary, the channel plugins and the admin key are not
yours to prepare — the plugin downloads and configures them on first start; an existing CPA on
the machine is reused, never overwritten.

Downloading needs access to GitHub Releases; configure a proxy where a direct connection does
not work.

## Install

From npm:

```
dsh plugin --profile <profile> add dsh-cpa-switch
```

Typing the package name `dsh-cpa-switch` into the GUI plugin manager is equivalent.

From a local directory (development):

```
plugin_manager action: install_bundle
target: <absolute path to this directory>
```

From this repository's source:

```
cd <this repository>
pnpm install
pnpm build
dsh plugin --profile web add .
```

The plugin must be installed under the chosen profile's `node_modules/`. If it does not show up
or shows as "not running", see the active pitfalls in [AGENTS.md](AGENTS.md).

## Configuration

| Field                 | Default         | Meaning                                                       |
| --------------------- | --------------- | ------------------------------------------------------------- |
| `adminKey`            | empty           | CPA admin key; leave empty to use the credential reference    |
| `adminKeyRef`         | `CPA_ADMIN_KEY` | Reference name in the credential store                        |
| `port`                | `8317`          | Port CPA listens on                                           |
| `exePath`             | empty           | Path to the CPA executable; leave empty to probe common spots |
| `manageLifecycle`     | `true`          | Whether the plugin starts and stops CPA                       |
| `autoCheckinOnStart`  | `true`          | Run one catch-up check-in at startup                          |
| `openControlPanel`    | `false`         | Also open CPA's own web console when it starts                |
| `reasoningEfforts`    | `true`          | Whether models expose a thinking level (off / on)             |
| `startTimeoutSeconds` | `30`            | Longest wait for CPA to become ready                          |

## Models for the conversation

Once the plugin is installed and an account is added, the four channels' models appear in DSH's
model picker on their own:

- Models are shown as `channel · model` (e.g. `WorkBuddy · deepseek-v4.1-flash`), so you can see
  at a glance which channel a request will use.
- This provider appears in DSH as **CPA Switch** — that is what you see in the model picker.
- When one model is served by several channels, each channel gets its own entry — **picking a
  channel means only that channel's accounts are used**, never round-robined across your other
  accounts.
- **Only usable accounts are listed**: models belonging to a disabled, failed, or currently
  unavailable account do not appear — the picker never offers an entry that turns out to be
  uncallable.
- **Only these four channels are listed**: CPA may host channels this plugin does not manage,
  and their models are left out. An unmanaged channel has no panel to configure it with, so
  listing its name would be worse than listing nothing.

Adding or removing accounts updates the model list automatically. How it works is described in
[Architecture](docs/ARCHITECTURE.md).

### Thinking level

Every model in the picker can switch its **thinking level** — two options:

- **off**: the model answers directly, with no visible reasoning.
- **on** (default): the model thinks first, and the reasoning is **visible** in the conversation.

On by default (`reasoningEfforts: true`). To turn the whole thing off, disable that switch in the
plugin settings — the Effort row disappears and requests go back to carrying no level.

⚠️ **Two levels is deliberate, not unfinished.** Measured against the upstream, the intermediate
notches (`low` / `medium` / `max`) **do not do what they say** — the spread within one level is
larger than the difference between levels — so offering them would set a false expectation. Only
two values with certain meaning are exposed: **off** and **on**. Data and reasoning are in the
[decision record](.agents/notes/2026-10-06-reasoning-effort-two-levels.md).

⚠️ **The word sent for "off" adapts to the channel** (zcode only accepts `none`, not `off`), so
choosing **off** works on all four channels without being rejected over wording.

⚠️ If the upstream ever rejects a level value (the whole turn errors out), **switch that setting
off** to recover.

> **Why there is no `Default` row in the menu**: DSH adds one only when a route declares no
> default level, and it carries the same "send no level" behaviour as **off** while its name reads
> like a value. The plugin declares the default level (**on**), so the menu is exactly
> **off / on**. Mechanism and trade-offs are in the
> [decision record](.agents/notes/2026-10-06-reasoning-default-row-removed.md).

## Known limitations

- **Windows only**: CPA currently ships as a Windows executable plus DLL plugins.
- **Downloading needs access to GitHub Releases**: a proxy is required where a direct connection
  does not work.
- **Rate-limited accounts look normal**: the panel showing "enabled" does not mean "usable right
  now"; it only surfaces when a conversation request fails — see the pitfall list in
  [Architecture](docs/ARCHITECTURE.md).

## Documentation

The maintainer documentation map lives in [AGENTS.md](AGENTS.md). Common entry points:

| Looking for                                                   | Where                                        |
| ------------------------------------------------------------- | -------------------------------------------- |
| Why it is designed this way (invariants, contracts, pitfalls) | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Host-half modules, internal HTTP route table                  | [src/README.md](src/README.md)               |
| The browser half                                              | [src/client/README.md](src/client/README.md) |
| Environment setup                                             | [src/setup/README.md](src/setup/README.md)   |
| Test coverage and how to run                                  | [tests/README.md](tests/README.md)           |
| What is next, where it is stuck                               | [docs/PLAN.md](docs/PLAN.md)                 |

## Development

```powershell
pnpm install
pnpm build        # tsdown dual-target build → lib/
pnpm check        # typecheck + lint + format + build + verify:artifacts + test
```

Editing the source requires a rebuild: the host loads the build output. After `pnpm build`,
restart DSH for the host side and refresh the page for the browser side.

## Acknowledgements

This project stands on the following open-source work, and thanks go to all of them:

| Part                                                                                                                                                                                                                                             | Source                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Engineering skeleton and plugin mechanics**: tsdown dual-target build, dual tsconfig, vitest / eslint / prettier, Cordis integration, config schema, React panel UI, lifecycle patterns                                                        | [dsh-workbuddy-bridge](https://github.com/zlZayn/dsh-workbuddy-bridge)                                                                                                                                 |
| **The managed host**: multi-channel proxy ProxyAPI, plus its account-file and routing management APIs (upstream code)                                                                                                                            | [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)                                                                                                                                            |
| **Channel protocols and the multi-channel capability**: WorkBuddy / Trae / Qoder / ZCode channel plugins, plus their account aggregation, check-in, task and balance protocols — this is what defines the panel's per-channel capability surface | [cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins) · [workbuddy-bridge-0.1.2-source](https://github.com/ki11a-Conton/workbuddy-bridge-0.1.2-source) (WorkBuddy channel protocol reference) |
| **Host platform**                                                                                                                                                                                                                                | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)                                                                                                                                    |

> The CLIProxyAPI runtime artifact is published from [cslkkl/CLIProxyAPI](https://github.com/cslkkl/CLIProxyAPI) (`release-windows` workflow); development and research additionally reference [zlZayn/CLIProxyAPI](https://github.com/zlZayn/CLIProxyAPI) (`local-autobrowser` branch). Both are essentially the same as upstream [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), differing only in where they live and which branch.

## Disclaimer

This project is for personal study and research only. It is not an official product and is not
affiliated with WorkBuddy, Trae, Qoder, ZCode or any other platform's official team.

- Account risk, credit changes and any other consequences arising from your use of this project
  are borne by you alone.
- Do not use it for commercial purposes.
- Each platform may change its service policy at any time; this project makes no guarantee that
  any feature keeps working.
- The author accepts no responsibility for any loss caused by using this project.

## Contributing

Issues and pull requests are welcome. Make sure `pnpm check` is green before submitting.

This repo's conventions live in [AGENTS.md](AGENTS.md): changes must keep the documentation
network in sync, and a link check runs after documentation changes (command in that file).

## License

MIT
