import "server-only";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ReviewFinding } from "@/lib/plan-types";

// MCP server name. The reviewing agent sees the tool as
// `mcp__phase_review__submit_review` — any allowedTools / canUseTool
// gating must use the FQN.
export const REVIEW_MCP_SERVER_NAME = "phase_review";
export const SUBMIT_REVIEW_TOOL_NAME = "submit_review";
export const SUBMIT_REVIEW_FQN = `mcp__${REVIEW_MCP_SERVER_NAME}__${SUBMIT_REVIEW_TOOL_NAME}`;

export interface ReviewSubmission {
  summary: string;
  findings: ReviewFinding[];
}

export interface ReviewMcpContext {
  // Called once when the agent invokes submit_review. The driver uses
  // this to persist the result onto the PhaseSession and resolve the
  // pending review promise. Idempotent at the call site — the driver
  // ignores subsequent invocations within the same review.
  onReviewSubmitted: (submission: ReviewSubmission) => void;
}

// createReviewMcpServer mints a one-shot MCP server hosting the
// submit_review tool. Re-created per review run so the closure scopes
// to the right driver instance.
export function createReviewMcpServer(ctx: ReviewMcpContext) {
  const submitReview = tool(
    SUBMIT_REVIEW_TOOL_NAME,
    "Submit your code review of the phase diff. Call this exactly once when you have finished reading the diff and formed your conclusions. Findings should be specific and actionable; if there are none, pass an empty array and a short summary noting that.",
    {
      summary: z
        .string()
        .min(1)
        .describe(
          "1-3 sentence overall summary of the diff: scope, quality, biggest concerns. Plain text, no markdown headers.",
        ),
      findings: z
        .array(
          z.object({
            severity: z
              .enum(["info", "warning", "error"])
              .describe(
                "info = nit/style/note · warning = correctness or maintainability concern · error = bug/security/breakage. Reserve 'error' for things that should block the change.",
              ),
            title: z
              .string()
              .min(1)
              .max(140)
              .describe("Short headline. e.g. 'Missing null check on user input'."),
            description: z
              .string()
              .min(1)
              .describe(
                "Explanation of the issue and a concrete suggestion. Plain text or fenced code; markdown ok.",
              ),
            file: z
              .string()
              .optional()
              .describe(
                "Repo-relative path of the affected file. Omit for diff-wide observations.",
              ),
            line: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("1-indexed line number. Omit when not file-specific."),
            category: z
              .string()
              .optional()
              .describe(
                "Free-form theme tag — e.g. 'security', 'perf', 'style', 'correctness', 'tests'. The UI groups by this when present.",
              ),
          }),
        )
        .describe(
          "Discrete issues. Empty array means clean — pair with a summary that says so.",
        ),
    },
    async ({ summary, findings }) => {
      const normalized: ReviewFinding[] = findings.map((f) => ({
        severity: f.severity,
        title: f.title,
        description: f.description,
        file: f.file,
        line: f.line,
        category: f.category,
      }));
      ctx.onReviewSubmitted({ summary, findings: normalized });
      return {
        content: [
          {
            type: "text" as const,
            text: `Review submitted: ${normalized.length} finding(s). The PhaseBoard will surface them.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: REVIEW_MCP_SERVER_NAME,
    version: "0.1.0",
    tools: [submitReview],
  });
}
