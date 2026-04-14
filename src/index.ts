// Package-root npm installs resolve to dist/index.js.
// OpenCode plugin discovery uses the explicit ./server and ./tui exports.
export { OmniOpencodePlugin } from "./plugin.js"
export { OmniOpencodeTuiPlugin } from "./tui.js"
export { createSessionManager } from "./plugin/session-manager.js"
export { delegatedJobsList, delegatedJobSnapshot, delegatedJobCancel, delegatedJobResume } from "./plugin/tools.js"
export { recoverJobs } from "./plugin/recovery.js"
