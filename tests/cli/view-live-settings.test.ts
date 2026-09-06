import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { generateLiveDashboardHtml } from '../../src/cli/view-live.js';

describe('legacy live dashboard retained settings', () => {
  it('renders only supported local settings and agent-neutral onboarding', () => {
    const html = generateLiveDashboardHtml();

    expect(html).toContain("addCap('Memory engine', 'Local FTS5', true)");
    expect(html).toContain("addCap('Initial setup'");
    expect(html).toContain('autoCapture: autoCheck.checked');
    expect(html).toContain('autoUpdate: autoUpdateSelect.value');
    expect(html).toContain('sessionLimit: sessionLimit');
    expect(html).toContain("{ setupCompleted: true }");
    expect(html).toContain('already-running agent to use work_package');
    expect(html).toContain('does not run or wake agents');

    expect(html).not.toMatch(/LLM Provider|Smart Mode|wizard-provider|llm-provider|apiKey|\/v1\/reindex/);
    expect(html).not.toMatch(/Claude Code|Anthropic|OpenAI|Ollama/);
    expect(html).toContain("throw new Error('Invalid config response')");
    expect(html).not.toContain("configRes.data.config) || {}");
  });

  it('emits syntactically valid browser scripts', () => {
    const html = generateLiveDashboardHtml();
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];

    expect(scripts).toHaveLength(2);
    for (const [, script] of scripts) expect(() => new vm.Script(script)).not.toThrow();
  });
});
