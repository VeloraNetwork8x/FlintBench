export function defaultSettings() {
  return {
    roots: [],
    scanDepth: 3,
    autoAddGitRepos: false,
    terminal: { shell: '' }, // empty = platform default
    docker: { enabled: true },
    agents: {
      detection: true,
      readSessionFiles: true, // read-only metadata of ~/.claude and ~/.codex session files
      readTranscripts: false, // opt-in: live read-only view of external Claude Code conversations
      taskPreviews: true, // task-finished notifications quote the agent's last reply (read from its session file)
      resumeExchange: true, // Welcome back reads the agent's session file to count requests, files its tools edited, commands
      use: 'sometimes', // do you build with AI agents: none (no agent UI anywhere) | sometimes | mostly
      claude: { enabled: true, command: '' },
      codex: { enabled: true, command: '' },
      antigravity: { enabled: true, command: '' },
    },
    editor: { command: 'code', others: [] }, // the default editor, then the other ones offered in menus
    autoLockMinutes: 30,
    theme: 'dark',
    accent: '', // '' = the default sky blue, otherwise #rrggbb
    background: 'hive', // background pattern: hive | dots | grid | lines | none
    uiScale: 1, // size of the content area relative to its designed size (sidebar unchanged): one of UI_SCALES
    profile: 'builder', // structure + style of the console: see app/web/js/lib/profiles.js (custom: customProfile)
    customProfile: null, // { base, flags, style: { accent, background, density }, startTab } once Custom was edited
    notifications: { level: 'all' }, // all | important (agents finishing, pushes) | quiet (only what you asked for)
    setup: { done: false, answers: null }, // the first-run setup (wizard) and what was answered
    onboarded: false, // older flag, unused
  };
}
