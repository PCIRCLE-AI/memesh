import { jsonStringLiteral, projectLabel, sliceWholeChars } from './work-topology.js';
import { redactShownTogether } from './paths.js';
export const TASK_STATE_TYPE = 'task-state';
export const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'];
export const MAX_FIELD_CHARS = 300;
export function taskStateName(project) {
    return `${TASK_STATE_TYPE}:${project}`;
}
export function taskStateUnreadableMessage(project) {
    return `task state for project ${jsonStringLiteral(projectLabel(project))} is not readable: the stored record is not valid JSON. Set a non-empty field with \`memesh task --goal …\` to replace the broken record.`;
}
export function parseTaskState(metadata) {
    const state = {};
    if (!metadata || typeof metadata !== 'object')
        return state;
    const raw = metadata.task_state;
    if (!raw || typeof raw !== 'object')
        return state;
    const bag = raw;
    for (const field of TASK_STATE_FIELDS) {
        const value = bag[field];
        if (typeof value !== 'string')
            continue;
        const trimmed = value.trim();
        if (trimmed)
            state[field] = trimmed;
    }
    const updated = bag.updated_at;
    if (typeof updated === 'string' && updated.trim())
        state.updated_at = updated.trim();
    const legacy = bag.legacy_updated_at;
    if (typeof legacy === 'string') {
        const trimmed = legacy.trim();
        const match = ZONED_INSTANT.exec(trimmed);
        if (match?.groups && isRealInstant(match.groups))
            state.legacy_updated_at = trimmed;
    }
    if (bag.stated_at !== undefined) {
        state.stated_at = {};
        const dates = bag.stated_at;
        if (dates && typeof dates === 'object' && !Array.isArray(dates)) {
            for (const field of TASK_STATE_FIELDS) {
                const date = dates[field];
                if (!state[field] || typeof date !== 'string')
                    continue;
                const trimmed = date.trim();
                const match = ZONED_INSTANT.exec(trimmed);
                if (match?.groups && isRealInstant(match.groups))
                    state.stated_at[field] = trimmed;
            }
        }
    }
    return state;
}
function fieldStatedAt(state, field) {
    return state.stated_at === undefined ? state.updated_at : state.stated_at[field];
}
export function normalizeFieldValue(value) {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat)
        return null;
    return flat.length > MAX_FIELD_CHARS ? `${sliceWholeChars(flat, MAX_FIELD_CHARS - 1).trimEnd()}…` : flat;
}
export function mergeTaskState(previous, patch, now) {
    const state = { ...previous };
    const changed = [];
    const observations = [];
    for (const field of TASK_STATE_FIELDS) {
        const incoming = patch[field];
        if (incoming === undefined)
            continue;
        const normalized = normalizeFieldValue(incoming);
        const current = state[field];
        if (normalized === (current ?? null))
            continue;
        changed.push(field);
        if (normalized === null) {
            delete state[field];
            observations.push(`${field} cleared`);
        }
        else {
            state[field] = normalized;
            observations.push(`${field}: ${normalized}`);
        }
    }
    if (changed.length > 0) {
        if (previous.stated_at === undefined && previous.updated_at !== undefined) {
            const match = ZONED_INSTANT.exec(previous.updated_at);
            if (match?.groups && isRealInstant(match.groups))
                state.legacy_updated_at = previous.updated_at;
        }
        state.stated_at = {};
        for (const field of TASK_STATE_FIELDS) {
            if (!state[field])
                continue;
            const date = changed.includes(field) ? now : previous.stated_at?.[field];
            if (date !== undefined)
                state.stated_at[field] = date;
        }
        state.updated_at = now;
    }
    return { state, changed, observations };
}
export function isEmptyTaskState(state) {
    return TASK_STATE_FIELDS.every((field) => !state[field]);
}
const FIELD_LABELS = {
    goal: 'Goal',
    next: 'Next',
    blocked: 'Blocked',
    done: 'Had just finished',
};
function ageInDays(updatedAt, now) {
    const age = resolveTaskStateAge(updatedAt, now);
    return age.known ? Math.floor(age.hours / 24) : null;
}
export function taskStateLines(state, project, now = new Date()) {
    if (isEmptyTaskState(state))
        return [];
    const days = ageInDays(state.updated_at, now);
    const age = days === null ? 'at some point' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    const lines = [state.stated_at === undefined
            ? `Stated about ${jsonStringLiteral(projectLabel(project))} ${age}, and not revisited since:`
            : `Stated about ${jsonStringLiteral(projectLabel(project))} (each field has its own date):`];
    const present = TASK_STATE_FIELDS.filter((field) => state[field]);
    const shown = redactShownTogether(present.map((field) => state[field]));
    present.forEach((field, i) => {
        let dateLabel = '';
        if (state.stated_at !== undefined) {
            const date = fieldStatedAt(state, field);
            const fieldAge = resolveTaskStateAge(date, now);
            const days = fieldAge.known ? Math.floor(fieldAge.hours / 24) : null;
            const ageLabel = days === null ? 'unknown date' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
            dateLabel = fieldAge.known ? ` (stated ${date}; ${ageLabel})` : ` (${ageLabel})`;
        }
        lines.push(`- ${FIELD_LABELS[field]}:${dateLabel} ${shown[i]}`);
    });
    return lines;
}
export const STALE_TASK_STATE_HOURS = 72;
export const CLOCK_SKEW_ALLOWANCE_MINUTES = 5;
const ZONED_INSTANT = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt](?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?(?:(?<zulu>[Zz])|(?<offSign>[+-])(?<offHour>\d{2}):?(?<offMinute>\d{2}))$/;
function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(year, month) {
    return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}
function isRealInstant(groups) {
    const year = Number(groups.year);
    const month = Number(groups.month);
    const day = Number(groups.day);
    const hour = Number(groups.hour);
    const minute = Number(groups.minute);
    const second = groups.second === undefined ? 0 : Number(groups.second);
    if (month < 1 || month > 12)
        return false;
    if (day < 1 || day > daysInMonth(year, month))
        return false;
    if (hour > 23)
        return false;
    if (minute > 59)
        return false;
    if (second > 59)
        return false;
    if (groups.zulu === undefined) {
        const offHour = Number(groups.offHour);
        const offMinute = Number(groups.offMinute);
        if (offHour > 23 || offMinute > 59)
            return false;
        if (groups.offSign === '-' && offHour === 0 && offMinute === 0)
            return false;
    }
    return true;
}
function resolveTaskStateAge(updatedAt, now) {
    if (!updatedAt)
        return { known: false };
    const match = ZONED_INSTANT.exec(updatedAt);
    if (!match?.groups || !isRealInstant(match.groups))
        return { known: false };
    const then = Date.parse(updatedAt);
    if (Number.isNaN(then))
        return { known: false };
    const hours = (now.getTime() - then) / 3_600_000;
    if (hours < -(CLOCK_SKEW_ALLOWANCE_MINUTES / 60))
        return { known: false };
    return { known: true, hours: Math.max(0, hours) };
}
function staleTaskStateLine(project, hours) {
    const days = Math.floor(hours / 24);
    const age = days >= 1 ? `${days} day${days === 1 ? '' : 's'} ago` : `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} ago`;
    return `Task state for ${jsonStringLiteral(projectLabel(project))} was last stated ${age} — older than ${STALE_TASK_STATE_HOURS}h, so it is not shown as current. Run \`memesh task\` to see or update it.`;
}
function taskStateAgeUnknownLine(project) {
    return `Task state for ${jsonStringLiteral(projectLabel(project))} has a missing, unreadable, or future-dated timestamp, so its age could not be established — not shown as current. Run \`memesh task\` to see or update it.`;
}
export function briefingTaskStateLines(state, project, now = new Date(), { includeFresh = true } = {}) {
    if (isEmptyTaskState(state))
        return [];
    if (state.stated_at !== undefined) {
        const present = TASK_STATE_FIELDS.filter((field) => state[field]);
        const ages = present.map((field) => resolveTaskStateAge(fieldStatedAt(state, field), now));
        const fresh = present.filter((_, index) => ages[index].known && ages[index].hours <= STALE_TASK_STATE_HOURS);
        if (fresh.length === 0) {
            if (ages.some((age) => !age.known))
                return [taskStateAgeUnknownLine(project)];
            return [staleTaskStateLine(project, Math.min(...ages.map((age) => age.known ? age.hours : Infinity)))];
        }
        const shown = { updated_at: state.updated_at, stated_at: state.stated_at };
        const redacted = redactShownTogether(present.map((field) => state[field]));
        present.forEach((field, index) => { if (fresh.includes(field))
            shown[field] = redacted[index]; });
        const lines = includeFresh ? taskStateLines(shown, project, now) : [];
        const omitted = present.filter((field) => !fresh.includes(field));
        if (omitted.length > 0) {
            lines.push(`Task state for ${jsonStringLiteral(projectLabel(project))} has older or unknown-age fields (${omitted.join(', ')}) not shown as current. Run \`memesh task\` to see or update them.`);
        }
        return lines;
    }
    const age = resolveTaskStateAge(state.updated_at, now);
    if (!age.known)
        return [taskStateAgeUnknownLine(project)];
    if (age.hours > STALE_TASK_STATE_HOURS) {
        return [staleTaskStateLine(project, age.hours)];
    }
    return includeFresh ? taskStateLines(state, project, now) : [];
}
//# sourceMappingURL=task-state.js.map