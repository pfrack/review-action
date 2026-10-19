export interface ReviewMetrics {
  pr_number: number;
  model_used: string;
  findings_count: { critical: number; warning: number; suggestion: number };
  files_reviewed: number;
  review_duration_ms: number;
  validation_dropped: number;
  batch_count: number;
}

export function formatMetrics(metrics: ReviewMetrics): string {
  const duration = metrics.review_duration_ms > 0
    ? `${(metrics.review_duration_ms / 1000).toFixed(1)}s`
    : 'N/A';

  const totalFindings = metrics.findings_count.critical
    + metrics.findings_count.warning
    + metrics.findings_count.suggestion;

  const lines = [
    '## Review Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Model | \`${metrics.model_used}\` |`,
    `| Files reviewed | ${metrics.files_reviewed} |`,
    `| Duration | ${duration} |`,
    `| Total findings | ${totalFindings} |`,
    '',
    '### Severity Breakdown',
    '',
    '| Severity | Count |',
    '|----------|-------|',
    `| 🚨 Critical | ${metrics.findings_count.critical} |`,
    `| ⚠️ Warning | ${metrics.findings_count.warning} |`,
    `| 💡 Suggestion | ${metrics.findings_count.suggestion} |`,
  ];

  if (metrics.validation_dropped > 0) {
    lines.push('');
    lines.push(`**Validation:** ${metrics.validation_dropped} finding(s) dropped by validation`);
  }

  if (metrics.batch_count > 1) {
    lines.push('');
    lines.push(`**Batching:** ${metrics.batch_count} batches (${Math.round(metrics.files_reviewed / metrics.batch_count)} files/batch avg)`);
  }

  return lines.join('\n');
}
