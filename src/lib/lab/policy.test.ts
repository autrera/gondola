import assert from "node:assert/strict";
import test from "node:test";
import { policyDirectives, policyPromptBlock } from "./policy";
import type { WorkflowPolicy } from "./types";

function policy(overrides: Partial<WorkflowPolicy> = {}): WorkflowPolicy {
  return {
    conceptCount: 1,
    useSeparateCritic: false,
    requireAnalyzeBeforeAnimate: false,
    reviseBelowQuality: null,
    maxRevisions: 0,
    budgetUsd: 1,
    ...overrides,
  };
}

test("policyDirectives is empty for a neutral policy", () => {
  assert.deepEqual(policyDirectives(policy()), []);
  assert.equal(policyPromptBlock(policy()), "");
});

test("policyDirectives reflects each enabled lever", () => {
  const directives = policyDirectives(policy({
    requireAnalyzeBeforeAnimate: true,
    useSeparateCritic: true,
    conceptCount: 3,
    reviseBelowQuality: 7,
    maxRevisions: 2,
    latencyMode: "fast",
  }));
  assert.equal(directives.length, 5);
  assert.ok(directives.some((directive) => /analyze_media/.test(directive)));
  assert.ok(directives.some((directive) => /3 distinct concepts/.test(directive)));
  assert.ok(directives.some((directive) => /below 7 out of 10/.test(directive)));
  assert.ok(directives.some((directive) => /Prioritize speed/.test(directive)));
});

test("policyPromptBlock renders directives as operating rules", () => {
  const block = policyPromptBlock(policy({ latencyMode: "fast" }));
  assert.ok(block.includes("Active workflow policy"));
  assert.ok(block.includes("- Prioritize speed"));
});
