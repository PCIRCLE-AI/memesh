import type { LessonSeverity } from './types.js';
import { lessonSlug } from './lesson-slug.js';
export declare function createExplicitLesson(rawError: string, rawFix: string, projectName: string | null, opts?: {
    rootCause?: string;
    prevention?: string;
    severity?: LessonSeverity;
    errorPattern?: string;
    sourceHost?: string;
}): {
    name: string;
};
export { KNOWN_ERROR_PATTERNS } from './project-attribution.js';
declare function inferErrorPattern(error: string): string;
export { inferErrorPattern, lessonSlug };
//# sourceMappingURL=lesson-engine.d.ts.map