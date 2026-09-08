export const RETIRED_ROUTES = {
    '/v1/consolidate': 'POST /v1/consolidate is retired. It rewrote memories with an LLM summary and deleted the originals, with no review step. Use the MCP work_package tool to stage an agent result, then review and accept or reject the proposal.',
    '/v1/verify': 'POST /v1/verify is retired along with the agentic-orchestration experiment. It recorded a verification report for background-agent work; the protocol it served was removed without ever leaving opt-in. Run your own verification (typecheck/tests/lint) and store conclusions with POST /v1/remember if you want them remembered.',
};
//# sourceMappingURL=retired-routes.js.map