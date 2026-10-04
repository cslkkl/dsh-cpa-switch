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

Check balances, check in, run tasks, switch accounts — without opening CPA's own web console.

Install the plugin and you are done: the CPA binary, the channel plugins, the config and the
admin key are all prepared by the plugin itself.

> [!NOTE]
> **The admin key never leaves the host.** The browser half only calls the plugin's own
> `/api/v1/cpa/*`; the host attaches the key when talking to CPA. The browser can neither see
> nor obtain it.

## What it does

Open **Plugins → CPA panel** in DSH. Each of the four channels gets its own tab:

- **Account balances**: available / used / pool / package count. Tokens and credits are
  counted separately and never summed together.
- **One-click actions**: check in all, run all tasks, refresh; each account can also be
  checked in / run individually.
- **Choose an account**: click "Use only this" on an account and **every other account in the
  same channel is disabled automatically** — one channel spends credits from one account, with
  no per-account toggling.
- **Add an account**: the "+ Add account" tile at the end of each channel's list opens the OAuth
  authorization page. Finish in the browser — no callback URL copying.
- **Remembers your choice**: the account you picked is still the one in use after a DSH restart.
- **Auto check-in switch**: reads and writes CPA's `checkin_auto`.
- **Process lifecycle**: CPA starts with DSH (an already-running instance is reused), and DSH
  only stops the instance it started itself.
- **Startup top-up**: CPA's own 09:00 / 21:00 timers are missed while DSH is not running, so
  the plugin performs one catch-up run at startup.
- **Models registered into the conversation**: once CPA is ready, the four channels' models
  appear in DSH's model picker as `channel · model` (see [below](#models-for-conversation)) —
  install the plugin, add an account, and use them straight away, with no config file to edit and
  no script to run.

### The four channels

| Channel   | Accounts | Balance unit | Check-in | Tasks |
| --------- | -------- | ------------ | -------- | ----- |
| WorkBuddy | several  | credits      | ✅       | ✅    |
| Trae      | several  | credit pool  | ✅       | —     |
| Qoder     | single   | credits      | ✅       | —     |
| ZCode     | single   | **token**    | —        | —     |

**Degrades by capability**: a capability the plugin does not support is not rendered at all —
no button that "does nothing when clicked".

## Security

**The admin key lives only in the host half and is never sent to the browser.** The browser only
calls the plugin's own `/api/v1/cpa/*`; the host attaches the key when calling CPA, and CPA only
listens on `127.0.0.1`. See [Architecture §4.1](docs/ARCHITECTURE.md).

## Requirements

Only **DSH** (DeepSeek Harness). This plugin **does not bundle CPA**; it is CPA's management UI.

The CPA binary, the channel plugins (`workbuddy.dll` and friends) and the admin key **are not
yours to prepare** — on first start the plugin does all of it in one pass: download → verify
sha256 → extract → generate config → generate the admin key. Downloads go through the system
proxy (the built-in `fetch` ignores `HTTPS_PROXY`, hence `src/net.ts`).

An **existing CPA on the machine is reused, never overwritten** (detected by "exe exists / dll
count > 0").

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

Either way, the plugin must end up as a **real directory under the profile's `node_modules/`**
(not a symlink). A same-named entry in the profile's `dependencies` is the _installed
declaration_; the one in `dsh.profile.bundles` is the _load declaration_ — both are required.

**Why `link:` pointing outside the profile tree does not work**: DSH's runtime resolution scopes
links by **real directory**. A link outside the profile makes the plugin's `@deepseek-ai/*`
imports fall back to native Node resolution, and `profiles/node_modules` is not in their ancestor
chain → `ERR_MODULE_NOT_FOUND` → the plugin shows as "not running".

## Configuration

| Field                 | Default         | Meaning                                                   |
| --------------------- | --------------- | --------------------------------------------------------- |
| `adminKey`            | empty           | CPA admin key; empty falls back to a credential reference |
| `adminKeyRef`         | `CPA_ADMIN_KEY` | Reference name in the credential store                    |
| `port`                | `8317`          | Port CPA listens on                                       |
| `exePath`             | empty           | Path to the CPA executable; empty probes common locations |
| `manageLifecycle`     | `true`          | Whether this plugin starts and stops CPA                  |
| `autoCheckinOnStart`  | `true`          | Whether to run a catch-up check-in at startup             |
| `openControlPanel`    | `false`         | Let CPA open its own console window on start              |
| `startTimeoutSeconds` | `30`            | Longest wait for CPA to become ready                      |

## Models for the conversation

The plugin **registers CPA's model catalog at runtime** with DSH's llm service: the
`CPA` provider in the model picker is pushed by the plugin, **not** declared statically in the
package.

- **The source is live**: CPA's `/v1/models` plus per-credential channel attribution
  (`auth-files/models`). A channel's models appear only once you have an account on that channel,
  and disappear when the account is removed.
- **Mechanism**: `llm-pi-ai`'s `providers` is a volatile config field — the plugin performs a
  volatile update on it (committed in-process, routes re-registered atomically), **with no DSH
  restart and nothing written to disk**. Providers you declared yourself on the Models page are
  left untouched.
- **Triggers**: CPA becoming ready (startup / setup finished) and an OAuth account being added.
  The catalog is pushed only once it settles on "same count twice in a row" — credentials load in
  batches after CPA starts, so reading immediately yields an incomplete catalog.
- **Display name**: `channel · model` (e.g. `WorkBuddy · deepseek-v4.1-flash`); models whose
  attribution is unknown get a `CPA ·` prefix.
- **Metadata is not guessed**: context window / output limit / modality fall back to the route
  defaults (262k / 32k / plain text) until a measured source exists.

The calling key uses the `CPA_API_KEY` credential reference (prepared automatically at plugin
startup; see [Security](#security)).

## Known limitations

- **Windows only**: CPA currently ships as a Windows executable plus DLL plugins.
- **CPA's configuration is not modified**: the plugin only calls CPA's management APIs. Routing
  strategy and the rest stay under CPA's `config.yaml`.
- **Downloading CPA needs access to GitHub Releases**: a proxy is needed where a direct connection
  does not work — the plugin prefers `HTTPS_PROXY` / `ALL_PROXY` and similar environment
  variables, then falls back to the Windows system proxy (**only effective while the system proxy
  is switched on**; configuring just the server address with the master switch off is not
  readable).
- **`disabled` is the only reliable "single account" mechanism**: `priority` merely means "prefer
  the higher one", and `fill-first` takes "the first usable credential" — both fall back to
  another account when the preferred one is unavailable. Only being disabled means "not taking
  part at all", which is what the panel's "Use only this" does.
- **Rate-limited accounts look normal**: upstream has model-level rate limits (code 6004), and a
  limited account still reports `status: active` in CPA. It only shows up once a real request is
  made — the panel showing "enabled" does not mean "this account works right now".
- **Editing the source requires a rebuild**: the host loads `lib/`, not `src/`. After
  `pnpm build`, restart DSH for the host half and refresh the page for the browser half — see the
  active pitfalls in [AGENTS.md](AGENTS.md).

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

`lib/` is a build artifact and is **not tracked** — build it first after cloning:

```powershell
pnpm install
pnpm build        # tsdown dual-target build → lib/
pnpm check        # typecheck + lint + format + build + verify:artifacts + test
```

The host loads `lib/`, so **changed source only takes effect after a rebuild**; the
`src/index.ts` side also needs a DSH restart, while the `src/client/` side only needs a refresh.

Read the "Global rules" and "Change impact routing" sections of [AGENTS.md](AGENTS.md) before
editing — it is injected into agents automatically and is this repo's maintainer index.

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
