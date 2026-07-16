import type { WorkflowPolicy } from "./types";

// Policy -> behavior. A promoted champion config only matters if it actually
// changes what the acting agent does. This turns the champion's workflow policy
// into concrete operating directives injected into the live system prompt, so a
// promotion in Gondola Lab produces a real behavior change (harness benefit),
// not just a stored config the runtime ignores.

export function policyDirectives(policy: WorkflowPolicy): string[] {
  const directives: string[] = [];
  if (policy.requireAnalyzeBeforeAnimate) {
    directives.push("Before turning any generated image into a video, first inspect it with analyze_media (or an equivalent check) and confirm it is good. Never animate an unreviewed image.");
  }
  if (policy.useSeparateCritic) {
    directives.push("Run a separate critique pass on creative work before presenting it as final, rather than judging your own first draft.");
  }
  if (policy.conceptCount > 1) {
    directives.push(`Develop at least ${policy.conceptCount} distinct concepts and choose the strongest before committing to one.`);
  }
  if (policy.reviseBelowQuality !== null && policy.maxRevisions > 0) {
    directives.push(`If a result's quality is below ${policy.reviseBelowQuality} out of 10, revise it (up to ${policy.maxRevisions} time${policy.maxRevisions === 1 ? "" : "s"}) before finishing.`);
  }
  if (policy.latencyMode === "fast") {
    directives.push("Prioritize speed: keep answers tight, minimize deliberation and long reasoning, and avoid unnecessary tool calls.");
  }
  return directives;
}

export function policyPromptBlock(policy: WorkflowPolicy): string {
  const directives = policyDirectives(policy);
  if (!directives.length) return "";
  return [
    "Active workflow policy (promoted through Gondola Lab, your control plane). Follow these operating rules for this session:",
    ...directives.map((directive) => `- ${directive}`),
  ].join("\n");
}
