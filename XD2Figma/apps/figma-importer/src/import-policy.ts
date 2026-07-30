import type { MigrationIssue } from '../../../packages/core/src';

export const IMPORT_POLICY = 'BEST_EFFORT_ALL_ARTBOARDS';

/** Compatibility findings remain auditable but do not exclude an artboard. */
export function asBestEffortIssue(issue: MigrationIssue): MigrationIssue {
  if (issue.severity === 'warning') return issue;
  return {
    ...issue,
    severity: 'warning',
    allowedActions: [],
    message: `${issue.message} ベストエフォート変換で代替表現を作成します。`,
    details: { ...issue.details, originalSeverity: issue.severity, importPolicy: IMPORT_POLICY },
  };
}

/** Collapse thousands of repeated node findings into one auditable item/code. */
export function aggregateBestEffortIssues(issues: MigrationIssue[]): MigrationIssue[] {
  const groups = new Map<string, {
    issue: MigrationIssue;
    occurrences: number;
    artboardGuids: Set<string>;
    nodeGuids: Set<string>;
    originalSeverities: Set<string>;
  }>();

  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}`;
    const existing = groups.get(key);
    const originalSeverity = typeof issue.details?.originalSeverity === 'string' ? issue.details.originalSeverity : issue.severity;
    if (existing) {
      existing.occurrences += 1;
      for (const guid of issue.artboardGuids) existing.artboardGuids.add(guid);
      for (const guid of issue.nodeGuids) existing.nodeGuids.add(guid);
      existing.originalSeverities.add(originalSeverity);
      continue;
    }
    groups.set(key, {
      issue,
      occurrences: 1,
      artboardGuids: new Set(issue.artboardGuids),
      nodeGuids: new Set(issue.nodeGuids),
      originalSeverities: new Set([originalSeverity]),
    });
  }

  return [...groups.values()].map((group) => ({
    ...group.issue,
    id: `best-effort-${group.issue.code.toLocaleLowerCase()}`,
    message: group.occurrences > 1 ? `${group.issue.message}（同種 ${group.occurrences}件を集約）` : group.issue.message,
    artboardGuids: [...group.artboardGuids],
    nodeGuids: [...group.nodeGuids],
    details: {
      ...group.issue.details,
      occurrences: group.occurrences,
      originalSeverities: [...group.originalSeverities],
      importPolicy: IMPORT_POLICY,
    },
  }));
}

export function bestEffortWarning(
  code: string,
  message: string,
  nodeGuids: string[] = [],
  artboardGuids: string[] = [],
  details?: Record<string, unknown>,
): MigrationIssue {
  return {
    id: `${code.toLocaleLowerCase()}-${nodeGuids.join('-') || artboardGuids.join('-') || 'package'}`,
    scope: nodeGuids.length ? 'node' : artboardGuids.length ? 'artboard' : 'package',
    severity: 'warning',
    code,
    message,
    artboardGuids,
    nodeGuids,
    allowedActions: [],
    details: { ...details, importPolicy: IMPORT_POLICY },
  };
}
