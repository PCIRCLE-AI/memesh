import { markdownSection } from './markdown-section.mjs';

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function tableBody(section, header) {
  const start = section.indexOf(header);
  if (start === -1) return null;
  const tail = section.slice(start).split('\n');
  const rows = [];
  for (let index = 2; index < tail.length && tail[index].startsWith('|'); index += 1) rows.push(tail[index]);
  return rows;
}

function directHttpRoutes(server) {
  return [...server.matchAll(/app\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g)]
    .map((match) => `${match[1].toUpperCase()} ${match[2]}`);
}

function retiredHttpRoutes(server, retiredRoutes) {
  if (!/Object\.entries\(RETIRED_ROUTES\)/.test(server) || !/app\.post\(retiredRoute,/.test(server)) return [];
  return [...retiredRoutes.matchAll(/^\s*'(\/v1\/[^']+)':/gm)].map((match) => `POST ${match[1]}`);
}

function apiSummaryRoutes(apiReference) {
  const section = markdownSection(apiReference, 'HTTP REST API');
  if (section === null) return null;
  const rows = tableBody(section, '| Method | Endpoint | Description |');
  if (rows === null) return null;
  return rows.map((row) => {
    const match = row.match(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*([^| ]+)\s*\|/);
    return match ? `${match[1]} ${match[2]}` : null;
  }).filter(Boolean);
}

function architectureToolRows(architecture) {
  const section = markdownSection(architecture, 'transports/mcp/handlers.ts -- MCP Tool Handlers');
  if (section === null) return null;
  const rows = tableBody(section, '| Tool | Schema | Handler |');
  if (rows === null) return null;
  return rows.map((row) => {
    const match = row.match(/^\| `([a-z_]+)` \| ([A-Za-z]+Schema) \|/);
    return match ? { name: match[1], schema: match[2] } : null;
  }).filter(Boolean);
}

function registeredToolNames(handlers) {
  return [...handlers.matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((match) => match[1]);
}

function handlerSchemaMappings(handlers, names) {
  return names.map((name) => {
    const start = handlers.indexOf(`if (name === '${name}')`);
    if (start === -1) return { name, schema: null };
    const next = handlers.indexOf("\n    if (name === '", start + 1);
    const block = handlers.slice(start, next === -1 ? undefined : next);
    return { name, schema: block.match(/parseOrFail\(([A-Za-z]+Schema), args\)/)?.[1] ?? null };
  });
}

function configBodyContract(server) {
  const block = server.match(/const ConfigBody = z\.object\(\{([\s\S]*?)\n\}\)\.strict\(\);/)?.[1];
  if (!block) return null;
  const keys = [...block.matchAll(/^\s{2}([a-zA-Z]+): z\./gm)].map((match) => match[1]);
  const autoUpdate = block.match(/autoUpdate: z\.enum\(\[([^\]]+)\]\)/)?.[1]
    ?.match(/'([^']+)'/g)?.map((value) => value.slice(1, -1)) ?? [];
  return { keys: uniqueSorted(keys), autoUpdate };
}

function configExample(apiReference) {
  const section = markdownSection(apiReference, 'GET /v1/config');
  if (section === null) return { section: null, example: null };
  const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!json) return { section, example: null };
  try { return { section, example: JSON.parse(json) }; } catch { return { section, example: null }; }
}

function analyticsResultKeys(analytics) {
  const block = analytics.match(/return \{\s*healthScore,\s*healthFactors,([\s\S]*?)\n\s*\};/)?.[0];
  if (!block) return null;
  return uniqueSorted([...block.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9_]*)\s*(?::|,)/gm)]
    .map((match) => match[1]));
}

function analyticsExample(apiReference) {
  const section = markdownSection(apiReference, 'GET /v1/analytics');
  const json = section?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!section || !json) return { section, example: null };
  try { return { section, example: JSON.parse(json) }; } catch { return { section, example: null }; }
}

function headingAnchors(markdown) {
  return new Set(markdown.split('\n').flatMap((line) => {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1];
    if (!heading) return [];
    // GitHub removes punctuation but replaces each whitespace character with
    // a hyphen. Punctuation surrounded by spaces therefore leaves two
    // hyphens: `[4.2.11] — 2026-08-03` -> `4211--2026-08-03`.
    return [heading.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-')];
  }));
}

function linkedAnchors(markdown, targetName) {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...markdown.matchAll(new RegExp(`\\[[^\\]]+\\]\\([^)]*${escaped}#([a-z0-9-]+)\\)`, 'g'))]
    .map((match) => match[1]);
}

function internalAnchors(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(#([a-z0-9-]+)\)/g)].map((match) => match[1]);
}

function requireLinkedAnchors(errors, document, targetName, required, label) {
  const anchors = linkedAnchors(document, targetName);
  const missing = required.filter((anchor) => !anchors.includes(anchor));
  if (missing.length > 0) errors.push(`${label} must link to ${targetName} headings: missing=${missing.join(',')}`);
  return anchors;
}

export function checkCurrentDocumentationContracts(input) {
  const errors = [];
  const toolNames = registeredToolNames(input.handlers);
  const tools = uniqueSorted(toolNames);
  const documentedTools = architectureToolRows(input.architecture);
  if (documentedTools === null) errors.push('ARCHITECTURE MCP handler table is missing or malformed');
  else {
    const mappings = handlerSchemaMappings(input.handlers, toolNames);
    const expected = mappings.map(({ name, schema }) => `${name}:${schema}`).sort();
    const actual = documentedTools.map(({ name, schema }) => `${name}:${schema}`).sort();
    if (toolNames.length !== tools.length
      || documentedTools.length !== new Set(documentedTools.map(({ name }) => name)).size
      || mappings.some(({ schema }) => schema === null)
      || JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`ARCHITECTURE MCP handler table differs from handler schema mappings (code=${expected.join(',')}; docs=${actual.join(',')})`);
    }
  }
  if (input.architecture.includes('logCapabilities')) errors.push('ARCHITECTURE references removed logCapabilities');

  const forget = markdownSection(input.architecture, 'Archive knowledge or remove one observation (`forget`)');
  if (forget === null) errors.push('ARCHITECTURE forget section is missing');
  else {
    for (const claim of ['KnowledgeGraph.removeObservation', 'KnowledgeGraph.archiveEntity', 'never permanently deletes']) {
      if (!forget.includes(claim)) errors.push(`ARCHITECTURE forget section is missing ${claim}`);
    }
    for (const stale of ['KnowledgeGraph.deleteEntity', 'DELETE FROM entities', '{deleted:']) {
      if (forget.includes(stale)) errors.push(`ARCHITECTURE forget section still claims ${stale}`);
    }
  }
  const forgetSource = input.operations.match(/export function forget\([\s\S]*?(?=\/\*\*\n \* Pin or unpin)/)?.[0];
  if (!forgetSource || !forgetSource.includes('kg.removeObservation') || !forgetSource.includes('kg.archiveEntity')
    || forgetSource.includes('kg.deleteEntity')) {
    errors.push('operations.forget source no longer preserves observation removal plus entity archive semantics');
  }
  const apiForget = markdownSection(input.apiReference, 'forget');
  for (const claim of ['does not permanently delete data', 'only this observation is removed', 'entire entity is archived']) {
    if (!apiForget?.includes(claim)) errors.push(`API_REFERENCE forget section is missing ${claim}`);
  }

  const recall = markdownSection(input.architecture, 'Search knowledge (recall)');
  if (!recall?.includes('Return {entities, retrieval}; add conflicts only when non-empty (never a bare array)')) {
    errors.push('ARCHITECTURE recall section does not state the object envelope');
  }
  const httpArchitecture = markdownSection(input.architecture, 'transports/http/server.ts -- HTTP REST API Server');
  for (const field of ['health score and factors', 'memory-loop metric', 'critical-lesson counts', 'citation compliance', '30-day timeline', 'age matrix', 'knowledge radar']) {
    if (!httpArchitecture?.includes(field)) errors.push(`ARCHITECTURE analytics summary is missing ${field}`);
  }
  for (const stale of ['value metrics', 'cleanup suggestions']) {
    if (httpArchitecture?.toLowerCase().includes(stale)) errors.push(`ARCHITECTURE analytics summary still claims ${stale}`);
  }

  const directCalls = [...input.httpServer.matchAll(/app\.(get|post|put|delete|patch)\(/g)].length;
  const directRoutes = directHttpRoutes(input.httpServer);
  const retired = retiredHttpRoutes(input.httpServer, input.retiredRoutes);
  if (directCalls !== directRoutes.length + (retired.length > 0 ? 1 : 0)) {
    errors.push('HTTP route extraction left an unrecognized dynamic or multiline registration');
  }
  const routeEntries = [
    ...directRoutes.filter((route) => route.includes(' /v1/')),
    ...retired,
  ];
  const routes = uniqueSorted(routeEntries);
  if (routeEntries.length !== routes.length) errors.push('HTTP source contains duplicate method/path registrations');
  const webEntries = directRoutes.filter((route) => !route.includes(' /v1/'));
  const webRoutes = uniqueSorted(webEntries);
  if (webEntries.length !== webRoutes.length) errors.push('HTTP source contains duplicate non-API web routes');
  const documentedRoutes = apiSummaryRoutes(input.apiReference);
  if (documentedRoutes === null) errors.push('API_REFERENCE HTTP route summary table is missing or malformed');
  else if (documentedRoutes.length !== new Set(documentedRoutes).size
    || JSON.stringify([...documentedRoutes].sort()) !== JSON.stringify(routes)) {
    errors.push(`API_REFERENCE HTTP route table differs from server registrations (code=${routes.join(',')}; docs=${[...documentedRoutes].sort().join(',')})`);
  }
  const architectureRouteClaim = `${routes.length} \`/v1\` endpoints including ${retired.length === 2 ? 'two' : retired.length} retired 410 routes`;
  const architectureRouteClaimCount = input.architecture.split(architectureRouteClaim).length - 1;
  if (architectureRouteClaimCount !== 1) {
    errors.push(`ARCHITECTURE must state its route-count claim exactly once: count=${architectureRouteClaimCount}; claim=${architectureRouteClaim}`);
  }
  for (const route of webRoutes.map((value) => value.split(' ')[1])) {
    if (!input.architecture.includes(`\`${route}\``)) errors.push(`ARCHITECTURE is missing non-API web route ${route}`);
  }

  const sourceConfig = configBodyContract(input.httpServer);
  const documentedConfig = configExample(input.apiReference);
  if (sourceConfig === null) errors.push('ConfigBody extraction stopped matching http/server.ts');
  if (documentedConfig.section === null || documentedConfig.example === null) {
    errors.push('API_REFERENCE GET /v1/config JSON example is missing or invalid');
  } else if (sourceConfig !== null) {
    const data = documentedConfig.example?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(['config'])) {
      errors.push('API_REFERENCE GET /v1/config response must contain only data.config');
    } else {
      const sample = data.config;
      const keys = sample && typeof sample === 'object' && !Array.isArray(sample) ? uniqueSorted(Object.keys(sample)) : [];
      if (JSON.stringify(keys) !== JSON.stringify(sourceConfig.keys)) errors.push('API_REFERENCE GET /v1/config sample keys differ from ConfigBody');
      if (!sourceConfig.autoUpdate.includes(sample?.autoUpdate)) errors.push('API_REFERENCE GET /v1/config autoUpdate is not a supported enum value');
    }
    if (documentedConfig.section.includes('"capabilities"')) errors.push('API_REFERENCE GET /v1/config still shows a capabilities response');
  }

  const analyticsKeys = analyticsResultKeys(input.analytics);
  const documentedAnalytics = analyticsExample(input.apiReference);
  if (analyticsKeys === null) errors.push('AnalyticsResult return-key extraction stopped matching analytics.ts');
  if (documentedAnalytics.example === null) errors.push('API_REFERENCE GET /v1/analytics JSON example is missing or invalid');
  else if (analyticsKeys !== null) {
    const data = documentedAnalytics.example?.data;
    const keys = data && typeof data === 'object' && !Array.isArray(data) ? uniqueSorted(Object.keys(data)) : [];
    if (JSON.stringify(keys) !== JSON.stringify(analyticsKeys)) errors.push('API_REFERENCE GET /v1/analytics top-level keys differ from AnalyticsResult');
    for (const name of ['activity', 'quality', 'freshness', 'lessons']) {
      const factor = data?.healthFactors?.[name];
      if (!factor || typeof factor !== 'object' || Array.isArray(factor)
        || JSON.stringify(uniqueSorted(Object.keys(factor))) !== JSON.stringify(['detail', 'score', 'weight'])) {
        errors.push(`API_REFERENCE GET /v1/analytics healthFactors.${name} is not a HealthFactor object`);
      }
    }
    if (!Array.isArray(data?.timeline) || data.timeline.some((row) => typeof row?.date !== 'string' || 'day' in row)) {
      errors.push('API_REFERENCE GET /v1/analytics timeline must use date, not day');
    }
  }

  if (input.methodology.includes('buildQueryTerms()') || !input.methodology.includes('buildMatchExpression()')
    || !/function buildMatchExpression/.test(input.knowledgeGraph)) {
    errors.push('LongMemEval methodology does not name the shipped buildMatchExpression pipeline');
  }
  const methodologyAnchors = headingAnchors(input.methodology);
  const methodologySelfLinks = internalAnchors(input.methodology);
  if (!methodologySelfLinks.includes('23-fts5-query-construction')) {
    errors.push('LongMemEval METHODOLOGY.md must link to its FTS5 query-construction heading');
  }
  const methodologyLinks = [
    methodologySelfLinks,
    requireLinkedAnchors(errors, input.benchmarkResults, 'METHODOLOGY.md', [
      '3-what-this-benchmark-does-and-does-not-cover',
      '42-adapter-limitations',
    ], 'LongMemEval RESULTS.md'),
    requireLinkedAnchors(errors, input.benchmarkResultsReadme, 'METHODOLOGY.md', [
      '2-adapter-architecture',
    ], 'LongMemEval results/README.md'),
  ];
  for (const anchors of methodologyLinks) {
    for (const anchor of anchors) {
      if (!methodologyAnchors.has(anchor)) errors.push(`LongMemEval references missing METHODOLOGY heading ${anchor}`);
    }
  }
  const changelogAnchors = headingAnchors(input.changelog);
  const changelogLinks = [
    requireLinkedAnchors(errors, input.methodology, 'CHANGELOG.md', ['4211--2026-08-03'], 'LongMemEval METHODOLOGY.md'),
    requireLinkedAnchors(errors, input.benchmarkResultsReadme, 'CHANGELOG.md', ['4211--2026-08-03'], 'LongMemEval results/README.md'),
  ];
  for (const anchors of changelogLinks) {
    for (const anchor of anchors) {
      if (!changelogAnchors.has(anchor)) errors.push(`LongMemEval references missing CHANGELOG heading ${anchor}`);
    }
  }
  const engineFloor = input.packageJson.engines?.node?.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!engineFloor || !input.reproduce.includes(`Node.js >= ${engineFloor}`)) {
    errors.push('LongMemEval reproduction Node floor differs from package.json');
  }

  return { errors, routeCount: routes.length, webRouteCount: webRoutes.length, toolCount: toolNames.length };
}
