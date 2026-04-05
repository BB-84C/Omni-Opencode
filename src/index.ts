// Plugin entry — re-exports the canonical plugin function.
// The OpenCode plugin loader (opencode.json) points to dist/plugin.js.
// This file re-exports for library/test consumers and must stay aligned.
export { OmniOpencodePlugin } from "./plugin.js"
export { createSessionManager } from "./plugin/session-manager.js"
export { delegatedJobsList, delegatedJobSnapshot, delegatedJobCancel, delegatedJobResume } from "./plugin/tools.js"
export { recoverJobs } from "./plugin/recovery.js"
