import type { DetectWindowsPsmuxOptions, WindowsPsmuxDetection } from "./windows-psmux.js"

export const WINDOWS_PSMUX_BOOTSTRAP_SCRIPT: "bootstrap:windows-psmux"
export const WINDOWS_PSMUX_INSTALL_DOCS_URL: string

export function detectWindowsPsmux(options?: DetectWindowsPsmuxOptions): Promise<WindowsPsmuxDetection>
export function createWindowsPsmuxBootstrapReport(detection: WindowsPsmuxDetection): string
