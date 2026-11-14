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
admin key are all prepared by the plugin itself. You only need **DSH**; downloading needs access
to GitHub Releases (configure a proxy where a direct connection does not work).

> [!NOTE]
> **The key never leaves the host**: every action in the panel is performed by the plugin on
> your behalf. The admin key only lives on the host side — the web page can never see it.

## Quick start

1. **Install**:

   ```
   dsh plugin --profile <profile> add dsh-cpa-switch
   ```

   Typing the package name `dsh-cpa-switch` into the GUI plugin manager is equivalent. To install
   from source (development), see [CONTRIBUTING.md](CONTRIBUTING.md).

2. **Open the panel**: **Plugins → CPA Switch** in DSH. To keep it in the left sidebar, turn on
   the "Sidebar entry" switch at the bottom of the panel (off by default) — the entry then
   appears among the plugin icons in the left sidebar.

3. **Add an account**: the "+ Add account" entry at the end of each channel's list opens the
   OAuth page — finish the login in your browser. The four channels' models then appear in the
   chat model picker on their own.

If it does not show up, or shows as "not running", see the active pitfalls in
[AGENTS.md](AGENTS.md) (Chinese).

## What it does

- **See account balances**: available / used / quota pool / package count; tokens and credits stay
  separate, and balances at the million mark are abbreviated
- **Quota cycle reminders**: when the provider gives a cycle end date, expand a notice within the
  last seven days for the details
- **Check in all / run all tasks**: one click per channel, or per account
- **Enable / disable accounts**: "Use only this one" disables every other account in the channel, and a
  disabled account is **never routed to** (the plugin turns off the channel's own credit-driven
  auto-enable, so only you change that switch)
- **Remembers your choice**: after a restart the account you picked is still in use; if something
  changes it back, a host-side guard restores your choice within minutes and the panel says so
- **Automatic check-in**: check-ins missed while DSH was not running are caught up at startup
- **Process hosting**: CPA starts with DSH (an already-running instance is reused) and stops with it
- **Says why it will not start**: a taken port, a config-generation mismatch and a bad config each
  get their own message
- **Models registered automatically**: the four channels' models appear in the picker on their own,
  grouped by channel, and you can keep only the ones you use
- **Sidebar entry, off by default**: turn the switch on and the entry appears among the left
  sidebar's plugin icons

Per-item detail (config fields, channel differences, thinking levels, failure notices) →
[docs/USAGE.md](docs/USAGE.md) (Chinese).

## The four channels

WorkBuddy / Trae / Qoder / ZCode each get their own tab, and their models are grouped by channel
in the picker. The four channels do not report the same balance fields, and they do not all
support the same features (a feature a channel lacks is never rendered as a button that does
nothing) — per-item differences → [docs/USAGE.md](docs/USAGE.md) (Chinese).

## Security

The admin key only lives on the host side and is never sent to the browser — boundaries and
guards in [Architecture](docs/ARCHITECTURE.md).

## Known limitations

- **Windows only**: CPA currently ships as a Windows executable plus DLL plugins.
- **Downloading needs access to GitHub Releases**: a proxy is required where a direct connection
  does not work.
- **Rate-limited accounts look normal**: the panel showing "enabled" does not mean "usable right
  now"; it only surfaces when a conversation request fails.

## Documentation

How to use it, how to change it and why it is designed this way each have their own home:

| Looking for                                                      | Where                                        |
| ---------------------------------------------------------------- | -------------------------------------------- |
| **How to use it** (config fields / channel differences / levels) | [docs/USAGE.md](docs/USAGE.md)               |
| Why it is designed this way (invariants, contracts, pitfalls)    | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Host-half modules, internal HTTP route table                     | [src/README.md](src/README.md)               |
| The browser half                                                 | [src/client/README.md](src/client/README.md) |
| Environment setup                                                | [src/setup/README.md](src/setup/README.md)   |
| Test coverage and how to run                                     | [tests/README.md](tests/README.md)           |
| What is next, where it is stuck                                  | [docs/PLAN.md](docs/PLAN.md)                 |
| Maintainer index (rules / todo / active pitfalls)                | [AGENTS.md](AGENTS.md)                       |

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

Issues and pull requests are welcome. How to get started, install from source, the `pnpm check`
gate, commit and PR conventions, and documentation-sync requirements → [CONTRIBUTING.md](CONTRIBUTING.md)
(Chinese).

## License

MIT
