// Simple build-time feature flags. Flags default to off; enable one by setting
// the matching NEXT_PUBLIC_* environment variable to "true".
export const FEATURES = {
  /**
   * The custom Agents surface (sidebar section + workspace "Agents" tab for
   * creating/managing isolated agents). Hidden for now.
   * Enable with NEXT_PUBLIC_ENABLE_AGENTS_TAB=true.
   */
  agentsTab: process.env.NEXT_PUBLIC_ENABLE_AGENTS_TAB === "true",
} as const;
