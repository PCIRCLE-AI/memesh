export const TASK_STATE_TYPE = 'task-state';
export const TASK_STATE_FIELDS = ['goal', 'next', 'blocked', 'done'];
export const MAX_FIELD_CHARS = 300;
export function taskStateName(project) {
    return `${TASK_STATE_TYPE}:${project}`;
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
    return state;
}
export function normalizeFieldValue(value) {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat)
        return null;
    return flat.length > MAX_FIELD_CHARS ? `${flat.slice(0, MAX_FIELD_CHARS - 1).trimEnd()}…` : flat;
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
    if (changed.length > 0)
        state.updated_at = now;
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
    if (!updatedAt)
        return null;
    const then = Date.parse(updatedAt);
    if (Number.isNaN(then))
        return null;
    const days = Math.floor((now.getTime() - then) / 86_400_000);
    return days >= 0 ? days : null;
}
export function taskStateLines(state, project, now = new Date()) {
    if (isEmptyTaskState(state))
        return [];
    const days = ageInDays(state.updated_at, now);
    const age = days === null ? 'at some point' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    const lines = [`Stated about "${project}" ${age}, and not revisited since:`];
    for (const field of TASK_STATE_FIELDS) {
        const value = state[field];
        if (value)
            lines.push(`- ${FIELD_LABELS[field]}: ${value}`);
    }
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
    return `Task state for "${project}" was last stated ${age} — older than ${STALE_TASK_STATE_HOURS}h, so it is not shown as current. Run \`memesh task\` to see or update it.`;
}
function taskStateAgeUnknownLine(project) {
    return `Task state for "${project}" has a missing, unreadable, or future-dated timestamp, so its age could not be established — not shown as current. Run \`memesh task\` to see or update it.`;
}
export function briefingTaskStateLines(state, project, now = new Date(), { includeFresh = true } = {}) {
    if (isEmptyTaskState(state))
        return [];
    const age = resolveTaskStateAge(state.updated_at, now);
    if (!age.known)
        return [taskStateAgeUnknownLine(project)];
    if (age.hours > STALE_TASK_STATE_HOURS) {
        return [staleTaskStateLine(project, age.hours)];
    }
    return includeFresh ? taskStateLines(state, project, now) : [];
}
//# sourceMappingURL=task-state.js.map