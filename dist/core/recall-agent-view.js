export const RECALL_ENTITY_CONTENT_MAX_BYTES = 8 * 1024;
export const RECALL_RESPONSE_MAX_BYTES = 32 * 1024;
const RESPONSE_METADATA_RESERVE_BYTES = 128;
function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
function truncateToBytes(text, maxBytes) {
    if (maxBytes <= 0)
        return { text: '', cutBytes: byteLength(text) };
    const full = Buffer.from(text, 'utf8');
    if (full.byteLength <= maxBytes)
        return { text, cutBytes: 0 };
    let sliceLen = maxBytes;
    while (sliceLen > 0 && (full[sliceLen] & 0xc0) === 0x80)
        sliceLen--;
    const kept = full.subarray(0, sliceLen).toString('utf8');
    return { text: kept, cutBytes: full.byteLength - byteLength(kept) };
}
function bytesWith(kept, item) {
    return byteLength(JSON.stringify([...kept, item]));
}
function cutToFit(obs, budgetBytes) {
    let limit = budgetBytes;
    for (;;) {
        const { text, cutBytes } = truncateToBytes(obs, limit);
        const marked = `${text}${text ? ' ' : ''}… (+${cutBytes} more bytes)`;
        const jsonBytes = bytesWith([], marked);
        if (jsonBytes <= budgetBytes)
            return marked;
        if (limit === 0)
            return null;
        limit = Math.max(0, Math.min(limit - 1, Math.floor((limit * budgetBytes) / jsonBytes)));
    }
}
function packTags(tags, budgetBytes) {
    const kept = [];
    for (const tag of tags) {
        if (bytesWith(kept, tag) > budgetBytes)
            break;
        kept.push(tag);
    }
    return { kept, total: tags.length };
}
function packObservations(observations, budgetBytes) {
    const total = observations.length;
    const kept = [];
    let cutMidway = false;
    for (const obs of observations) {
        if (bytesWith(kept, obs) <= budgetBytes) {
            kept.push(obs);
            continue;
        }
        if (kept.length === 0) {
            const cut = cutToFit(obs, budgetBytes);
            if (cut !== null) {
                kept.push(cut);
                cutMidway = true;
            }
        }
        break;
    }
    return { kept, total, cutMidway };
}
function capEntityForAgent(entity) {
    const visibleTags = (entity.tags ?? []).filter((t) => !t.startsWith('file:'));
    const observations = entity.observations ?? [];
    const tagsResult = packTags(visibleTags, RECALL_ENTITY_CONTENT_MAX_BYTES);
    const tagsBytesUsed = byteLength(JSON.stringify(tagsResult.kept));
    const observationsBudget = Math.max(0, RECALL_ENTITY_CONTENT_MAX_BYTES - tagsBytesUsed);
    const obsResult = packObservations(observations, observationsBudget);
    const truncated = {};
    if (obsResult.kept.length < obsResult.total || obsResult.cutMidway) {
        truncated.observations = { shown: obsResult.kept.length, total: obsResult.total };
    }
    if (tagsResult.kept.length < tagsResult.total) {
        truncated.tags = { shown: tagsResult.kept.length, total: tagsResult.total };
    }
    const capped = { ...entity, tags: tagsResult.kept, observations: obsResult.kept };
    if (Object.keys(truncated).length > 0)
        capped.truncated = truncated;
    return capped;
}
export function capRecallForAgent(result) {
    const cappedEntities = result.entities.map(capEntityForAgent);
    const totalEntities = cappedEntities.length;
    const responseBudget = RECALL_RESPONSE_MAX_BYTES - RESPONSE_METADATA_RESERVE_BYTES;
    let shownCount = 0;
    for (let count = totalEntities; count >= 0; count--) {
        const candidateBytes = byteLength(JSON.stringify({
            entities: cappedEntities.slice(0, count),
            conflicts: result.conflicts,
            retrieval: result.retrieval,
        }));
        if (candidateBytes <= responseBudget) {
            shownCount = count;
            break;
        }
    }
    const shownEntities = cappedEntities.slice(0, shownCount);
    const entitiesDropped = shownCount < totalEntities;
    const anyContentTruncated = shownEntities.some((e) => e.truncated !== undefined);
    const envelope = {
        entities: shownEntities,
        conflicts: result.conflicts,
        retrieval: result.retrieval,
    };
    if (anyContentTruncated || entitiesDropped)
        envelope.truncated = true;
    if (entitiesDropped)
        envelope.entities_omitted = { shown: shownCount, total: totalEntities };
    return envelope;
}
export function agentRecallEnvelope(r) {
    return {
        entities: r.entities,
        retrieval: r.retrieval,
        ...(r.conflicts.length > 0 ? { conflicts: r.conflicts } : {}),
        ...(r.truncated ? { truncated: r.truncated } : {}),
        ...(r.entities_omitted ? { entities_omitted: r.entities_omitted } : {}),
    };
}
//# sourceMappingURL=recall-agent-view.js.map