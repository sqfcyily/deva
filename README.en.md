<div align="center">

[简体中文](README.md) | **English**

<img src="apps/desktop/build/icon.png" alt="Deva" width="128" height="128" />

# Deva

**A chat-first desktop AI assistant · All in Chat**

Use it as an everyday chat app; hand it a folder and it gets to work — reading code, editing files, running commands.<br />
It can also handle repetitive chores on a schedule, and you can keep chatting from your phone when you're away from your computer.

<p>
  <a href="https://github.com/sqfcyily/deva/releases"><img src="https://img.shields.io/github/v/release/sqfcyily/deva?style=flat-square&color=6D28D9&label=release" alt="Release" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-4F46E5?style=flat-square" alt="Platform" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7C3AED?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
  <a href="https://linux.do"><img src="https://img.shields.io/badge/LINUX%20DO-community-FFB003?style=flat-square" alt="LINUX DO Community" /></a>
</p>

<a href="https://github.com/sqfcyily/deva/releases"><b>Download</b></a> ·
<a href="#-quick-start"><b>Quick Start</b></a> ·
<a href="#-features"><b>Features</b></a> ·
<a href="#-before-you-start"><b>Before You Start</b></a> ·
<a href="#-run-from-source"><b>Run from Source</b></a>

</div>

---

<p align="center">
  <img src="docs/highlights.svg" alt="Deva highlights: All in Chat, multiple personas, subagents, code rewind, scheduled tasks, replying from your phone" width="100%" />
</p>

## ✨ Highlights
<table>
  <tr>
    <td width="33%" valign="top">
      <h3>🗣️ All in Chat</h3>
      Just say it in the chat: create a persona, set up a scheduled task, remember a habit, mount a folder… No digging through settings — click confirm and it's done.
    </td>
    <td width="33%" valign="top">
      <h3>🎭 Multiple personas, each with a specialty</h3>
      Ships with Deva, an all-round assistant, and 小码酱 (Xiaomajiang), a security research expert. Create your own too — each with its own personality, avatar and preferred model.
    </td>
    <td width="33%" valign="top">
      <h3>🤖 Subagents, multi-agent dispatch</h3>
      Big tasks get split up and dispatched to multiple subagents running in parallel. Three built-in types — General, Explore and Plan — each with its own context, returning only the conclusions.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>⏪ Broke something? Roll it back</h3>
      <code>/rewind</code> to before any turn. Code and conversation can be restored separately, and a rewind can itself be undone.
    </td>
    <td width="33%" valign="top">
      <h3>⏰ Scheduled tasks</h3>
      Create a task with one sentence; it runs on time and notifies you when done. Supports daily, weekly, monthly and cron.
    </td>
    <td width="33%" valign="top">
      <h3>📱 Keep chatting in IM</h3>
      Connect your favorite chat app. Away from your computer, messages from your phone go straight to Deva on your desktop.
    </td>
  </tr>
</table>

---

## 🚀 Quick Start

1. Download the installer from [Releases](https://github.com/sqfcyily/deva/releases) and install it (see [Installation](#-installation) below)
2. Open **Settings → Models**, pick a provider, enter your API key, and add the models you want to use
3. Back in the chat, choose a model above the input box and start chatting

Built-in providers:

<p>
  <img src="https://img.shields.io/badge/Anthropic-191919?style=flat-square" alt="Anthropic" />
  <img src="https://img.shields.io/badge/OpenAI-412991?style=flat-square" alt="OpenAI" />
  <img src="https://img.shields.io/badge/Google%20Gemini-1A73E8?style=flat-square" alt="Google Gemini" />
  <img src="https://img.shields.io/badge/DeepSeek-4D6BFE?style=flat-square" alt="DeepSeek" />
  <img src="https://img.shields.io/badge/Kimi-111111?style=flat-square" alt="Kimi" />
  <img src="https://img.shields.io/badge/Zhipu%20GLM-3859FF?style=flat-square" alt="Zhipu GLM" />
  <img src="https://img.shields.io/badge/Qwen-615CED?style=flat-square" alt="Qwen" />
  <img src="https://img.shields.io/badge/Ollama%20(local)-000000?style=flat-square" alt="Ollama" />
</p>

Any other OpenAI-compatible service can be added manually.

---

## 📖 Features

### 🗣️ All in Chat: just say what you need

Most of Deva's features can be used right in the conversation — no settings pages, no forms:

| You say | It does |
| --- | --- |
| "Create a persona for writing weekly reports, keep the tone formal" | Asks clarifying questions step by step, then gives you a persona card to confirm |
| "Every morning at 9, summarize yesterday's commits into a daily report" | Generates a task card; review it and it's created |
| "Remember: I use pnpm" | Saves it and takes it into account in every future conversation |
| "Take a look at the code in my-app" | Asks you to mount that project folder, then works around it |

For things like creating personas, scheduled tasks or mounting folders, it shows you a card first — nothing takes effect until you confirm.

### 🎭 Multiple personas, each with a specialty

Every conversation is with a "persona". A persona is more than a name: it has its own personality, speaking style and preferred model, so the same question can get answers from different perspectives. Pick a persona when starting a new conversation, and it stays in charge of that conversation.

**Built-in personas, ready to go:**

| Persona | Good at | Style |
| --- | --- | --- |
| **Deva** | All-round work assistant: coding, writing, research, file organization, data analysis, running commands | Mentor and friend — concise, warm and natural; gently points out problems in your ideas and suggests better ones |
| **小码酱 (Xiaomajiang)** | Red team / security research and reverse engineering, plus full-stack development and deep technical work | Hardcore techie vibe, great for digging into low-level details and tough problems |

> [!NOTE]
> **About 小码酱 (Xiaomajiang):** the persona prompt comes from [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and **only works with Chinese models** (e.g. DeepSeek, Kimi, Zhipu GLM, Qwen); results on other models are not guaranteed. Follow that project for prompt updates.

**Create your own:** give it a name, write its personality and style, pick a preferred model; the avatar can be customized or uploaded as an image. Don't feel like filling out a form? Click "Add via chat", or just say "create a persona that…" in a conversation — it will walk you through it and finally hand you a persona card to confirm.

Personas can be reordered by drag and drop, pinned, or disabled when you don't need them for a while.

### 💬 Works like a chat app

The conversation list is on the left. You can attach images, PDFs, code or text files to messages (whether images are understood depends on the model you choose). Code in replies has syntax highlighting and a copy button, and long conversations get an outline on the right for quick navigation.

### 🛠️ Hand it a folder and let it work

Without a folder, it's a general-purpose assistant for your whole computer; mount a folder and it focuses on that project:

- 🔍 Find files, search content, read code
- ✏️ Create and edit files
- ▶️ Run commands (install dependencies, run tests, build, etc.)
- 🌐 Open web links you give it and read the content

For bigger jobs, it looks around first and drafts a plan; it only starts once you click "Approve and execute", and you can ask it to keep refining the plan if you're not happy. When it needs your decision midway, it pops up options for you to pick — or you can type your own answer.

> [!TIP]
> If the project root contains an `AGENTS.md`, it reads it as the project guide and follows the conventions inside.

### 🤖 Subagents: split big tasks and run them in parallel

When a task requires going through many files, or can be split into independent pieces, it dispatches several "subagents" to work simultaneously, while it only handles dispatching and summarizing:

| Subagent | What it does | Can it make changes? |
| --- | --- | --- |
| **General** | General-purpose; independently completes an assigned task | Yes, same tools as the main conversation |
| **Explore** | Casts a wide net across the codebase: where, how many, how it's named — reported as `path:line` | Read-only, no file changes |
| **Plan** | Surveys the current state, then writes a step-by-step implementation plan, key files and trade-offs | Read-only, plans only |

- ⚡ **Truly parallel**: independent subtasks are dispatched in the same turn and run together
- 🧹 **Keeps the main chat clean**: each subagent has its own context; files it read and commands it ran stay out of the main conversation — only conclusions come back
- 🔍 **Visible process**: each subagent's work is collapsed into a card you can expand to see what it looked into
- 🧠 **Model follows along**: subagents use the model selected for the current conversation, no extra setup

### ⏪ Broke something? Roll it back

Type `/rewind` (or press <kbd>Esc</kbd> twice, or right-click in the chat and choose "Rewind to here"), pick a turn, and you're back to just before it. You can restore only the code, only the conversation, or both. Changed your mind afterwards? The rewind can be undone.

A few limitations: side effects of commands it ran can't be reverted; files you modified yourself outside Deva after the rewind point are skipped and not overwritten by default.

### 🌿 Git shortcuts

If the mounted folder is a Git repository, the current branch is shown next to the folder. Click it to pull, push, switch or create branches, and commit. The AI can write the commit message for you based on the changes.

This requires git to be installed; otherwise it won't be shown.

### ⏰ Scheduled tasks

Tell it "Every morning at 9, summarize yesterday's commits into a daily report" and it generates a task card. Check the time, instructions, persona and model, confirm, and it's created. You can also create tasks manually on the "Scheduled Tasks" page.

Schedules can be one-off, hourly, daily, weekly, monthly, every N minutes, or a custom cron expression. Tasks run automatically on time without asking you anything along the way; when done, a system notification pops up and the result is kept in the task's own conversation. You can pause, resume, run once immediately, or view run history at any time.

> [!NOTE]
> Tasks only run while Deva is open. On Windows, closing the window minimizes it to the tray by default so tasks keep running (can be turned off in settings). If several runs were missed while Deva was closed, only the most recent one is caught up the next time it opens.

### 🧠 Remembers your habits

Say "Remember: I use pnpm" and it saves it, taking it into account in every future conversation. Click your own avatar at the top of the leftmost sidebar to see what it remembers — edit, delete or clear as you like.

Memories can also be scoped to a single project, e.g. "Remember for this project: tests use vitest". These only apply within that folder, are stored on your computer, never enter the project repository, and aren't visible to others. To change or delete them, just tell it in a conversation within that project.

### 📱 Keep chatting on your phone

Once a chat app is connected, messaging the bot from your phone is the same as chatting with Deva on your computer: same personas, models, folders and tools, with the chat history visible on both sides.

Currently supports **Feishu** (including Lark international) and **Telegram**, with more IM platforms coming.

**Feishu: no need to create an app manually on the open platform**

1. Click "Bots" in the leftmost sidebar, click **+** and choose Feishu
2. Scan the QR code with Feishu and confirm app creation on your phone
3. Once created, the bot sends you a message, and the account that scanned the code automatically becomes its "owner"

**Telegram: scan all the way, no manual searching**

1. Click "Bots" in the leftmost sidebar, click **+** and choose Telegram
2. Scan the first QR code with your phone to open [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts to create a bot, then paste the token it replies with back into Deva and save
3. Scan the second QR code to open your new bot and tap "Start" — your account becomes its "owner"

> Telegram requires your computer to reach `api.telegram.org`. If you need a proxy, set the system proxy and Deva will use it automatically.


### 🧩 Skills and MCP

- **Skills**: written-up instructions for how to get something done, invoked with `/skill-name`. You can upload skill packages made by others (.zip or SKILL.md), or type `/create-skill` in a conversation and it will guide you through making your own.
- **MCP**: connect external tool services (databases, browsers, various third-party services). Just ask it to set one up in the chat; once configured, you can see the connection status and the tools it provides under "Settings → Extensions".

### 📚 Long conversations, no worries

When a conversation is about to fill the model's context window, earlier content is automatically compressed into a summary so you can keep going. You can also type `/compact` to compress manually at any time.

### 🎨 Other

- Delete chat history by "turn": right-click in the chat and choose "Delete this turn" or "Select to delete"; deleted content is no longer seen by the model either
- Light / dark / follow system theme; 简体中文 / English

---

## ⚠️ Before You Start

> [!WARNING]
> **It doesn't ask before each action.** Reading/writing files and running commands are executed directly, with no permission prompts. Keep important projects under Git, or back them up first.

- 💳 **Costs go to your own account.** Every conversation and every scheduled task consumes quota from the API key you provide.
- 🔒 **Your data stays local.** Settings, conversations, memories, tasks, skills, bot configs and more live under `~/.deva`, mostly as plain files you can open directly; API keys and bot credentials are stored encrypted. To use a different location, set the `DEVA_HOME` environment variable. If you use IM bots, messages from your phone pass through the corresponding IM platform's servers.

---

## 📦 Installation

Download from [Releases](https://github.com/sqfcyily/deva/releases):

| System | File | Notes |
| --- | --- | --- |
| 🪟 Windows | `Deva-x.y.z-setup.exe` | Double-click to install |
| 🪟 Windows MSI | `Deva-x.y.z.msi` | Supports Group Policy or silent install via `msiexec` |
| 🍎 macOS (Apple Silicon) | `Deva-x.y.z-arm64.dmg` | |
| 🍎 macOS (Intel) | `Deva-x.y.z-x64.dmg` | |

Install either the exe or the msi — installing both results in two separate programs.

<details>
<summary><b>Blocked by the system on first launch?</b></summary>

<br />

The installers are currently unsigned, so the system may block the first launch:

- **Windows**: when "Windows protected your PC" appears, click "More info" → "Run anyway"
- **macOS**: if it says the app can't be opened, go to "System Settings → Privacy & Security" and click "Open Anyway"; if it says the app is "damaged", run the following in Terminal and open it again:

  ```bash
  xattr -cr /Applications/Deva.app
  ```

</details>

---

## 🧑‍💻 Run from Source

Requires Node.js 20+ and pnpm:

```bash
pnpm install
pnpm dev               # start in development mode
pnpm package:win       # build Windows installer (exe)
pnpm package:win:msi   # build Windows MSI installer
pnpm package:mac       # build macOS installer
```

## 📄 License

[MIT](LICENSE)
